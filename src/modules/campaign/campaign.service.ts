import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate, ValidationError } from 'class-validator';
import { EmailService } from '../email';
import {
  Candidate,
  CandidateRole,
  CandidateStatus,
  GoogleSheetService,
  SHEET_COLUMNS,
  SheetConnection,
} from '../google-sheet';
import { RenderedEmail, TemplateService, TemplateType } from '../template';
import {
  CAMPAIGN_RUN_STATUS,
  DEFAULT_EMAIL_DELAY_MS,
  DEFAULT_EMAIL_MAX_RETRIES,
  DEFAULT_STALE_PROCESSING_THRESHOLD_MINUTES,
  ERROR_CLASSIFICATION,
  FAILED,
  PENDING,
  PROCESSING,
  SENT,
} from './campaign.constant';
import {
  CampaignCounts,
  CampaignPreviewResponse,
  CampaignRunResponse,
  CampaignSendResponse,
  CampaignStatusResponse,
  CandidatePreview,
  ConnectSheetResponse,
  FollowUpCounts,
  SendResultRow,
  SheetValidationReport,
} from './campaign.types';
import {
  classifyEmailError,
  describeError,
  formatDryRunCampaignId,
  isStaleProcessing,
  nextCampaignId,
} from './campaign.utils';
import { PreviewCandidatesDto } from './dto/preview-candidates.dto';
import { SendCampaignDto } from './dto/send-campaign.dto';

const VALIDATION_OPTIONS = {
  whitelist: false,
  forbidUnknownValues: false,
  validationError: { target: false, value: false },
};

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  /**
   * Single-run guard. V1 is deliberately single-instance, so an in-memory flag
   * is enough to stop two overlapping batches from sending the same row twice.
   */
  private isCampaignRunning = false;
  private activeCampaignId: string | null = null;

  constructor(
    private readonly googleSheetService: GoogleSheetService,
    private readonly templateService: TemplateService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async connectSheet(
    spreadsheetUrl: string,
    sheetName?: string,
  ): Promise<ConnectSheetResponse> {
    return this.googleSheetService.connect({ spreadsheetUrl, sheetName });
  }

  /**
   * Reports which sheet rows can be used for a send. Validation rules live on
   * the `Candidate` entity, so this only maps class-validator output onto the
   * row/field shape the API contract promises.
   */
  async validateSheet(): Promise<SheetValidationReport> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);

    const errors: SheetValidationReport['errors'] = [];
    let valid = 0;

    for (const candidate of candidates) {
      const rowErrors = await validateCandidate(candidate);

      if (rowErrors.length === 0) {
        valid += 1;
        continue;
      }

      errors.push(...rowErrors);
    }

    return {
      connection,
      total: candidates.length,
      valid,
      invalid: candidates.length - valid,
      errors,
    };
  }

  /**
   * Renders emails without sending them, so template copy can be reviewed
   * before a single message leaves the outbox.
   */
  async preview(dto: PreviewCandidatesDto): Promise<CampaignPreviewResponse> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);
    const eligible = await this.filterEligible(candidates, {
      role: dto.role,
    });

    const previews: CandidatePreview[] = eligible
      .slice(0, dto.limit)
      .map((candidate) => this.buildPreview(candidate, dto.type));

    return {
      connection,
      counts: summarize(candidates),
      eligible: eligible.length,
      type: dto.type,
      previews,
    };
  }

  /** Live counts, plus whether a run currently holds the single-run lock. */
  async getStatus(): Promise<CampaignStatusResponse> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);

    return {
      connection,
      counts: summarize(candidates),
      followUp: summarizeFollowUp(candidates),
      running: this.isCampaignRunning,
      activeCampaignId: this.activeCampaignId,
    };
  }

  /**
   * Starts a campaign.
   *
   * A dry run renders inline and answers with the rendered emails, because that
   * is the whole point of asking for one. A real send is handed to a background
   * run and answers immediately — a full batch would otherwise hold the HTTP
   * request open for `limit * EMAIL_DELAY_MS` and time out.
   */
  async send(dto: SendCampaignDto): Promise<CampaignRunResponse> {
    this.acquireRun();

    try {
      return await this.startSend(dto);
    } catch (error) {
      this.releaseRun();
      throw error;
    }
  }

  private async startSend(dto: SendCampaignDto): Promise<CampaignRunResponse> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);
    const allEligible = await this.filterEligible(candidates, {
      role: dto.role,
    });
    const eligible = allEligible.slice(0, dto.limit);

    if (allEligible.length > eligible.length) {
      // Never let a cap look like "that was everything".
      this.logger.warn(
        `Limit ${dto.limit} reached: ${allEligible.length} rows are eligible, ` +
          `${allEligible.length - eligible.length} were not processed`,
      );
    }

    // An explicit query param always wins; otherwise the environment decides,
    // and the environment defaults to dry-run.
    const dryRun =
      dto.dryRun ??
      this.configService.get<boolean>('campaign.sendDefaultDryRun', true);

    if (dryRun) {
      return this.renderBatch(
        connection,
        eligible,
        allEligible.length,
        dto.type,
      );
    }

    // The next free sequence number is derived from the ids already on the
    // sheet, so a restart cannot re-issue `campaign-20260927-001`.
    const campaignId = nextCampaignId(
      candidates.map((candidate) => candidate.campaignId),
      new Date(),
    );

    this.activeCampaignId = campaignId;
    this.logger.log(
      `Campaign ${campaignId} started for ${eligible.length} candidate(s)` +
        `${dto.role ? ` (role=${dto.role})` : ''}`,
    );

    // Ownership of the lock moves to the background run, which releases it.
    void this.executeCampaign(campaignId, eligible, dto.type);

    return {
      connection,
      status: CAMPAIGN_RUN_STATUS.STARTED,
      campaignId,
      dryRun: false,
      total: eligible.length,
    };
  }

  private renderBatch(
    connection: SheetConnection,
    eligible: Candidate[],
    eligibleCount: number,
    type: TemplateType,
  ): CampaignSendResponse {
    const campaignId = formatDryRunCampaignId(new Date());
    this.activeCampaignId = campaignId;

    try {
      this.logger.log(`[dry-run] rendering ${eligible.length} candidate(s)`);

      const results = eligible.map((candidate) =>
        this.renderOnly(candidate, type),
      );

      return {
        connection,
        status: CAMPAIGN_RUN_STATUS.DRY_RUN_COMPLETED,
        campaignId,
        dryRun: true,
        // The full eligible count, so a limit that cut the batch short is
        // visible in the response and not only in the logs.
        eligible: eligibleCount,
        processed: results.length,
        sent: 0,
        failed: 0,
        results,
      };
    } finally {
      this.releaseRun();
    }
  }

  /**
   * Runs one campaign to completion. Each row is settled before the next one
   * starts, so a single failure can never take the batch with it.
   */
  private async executeCampaign(
    campaignId: string,
    candidates: Candidate[],
    type: TemplateType,
  ): Promise<void> {
    try {
      for (const [index, candidate] of candidates.entries()) {
        await this.processCandidate(candidate, campaignId, type);

        if (index < candidates.length - 1) {
          await this.delayBetweenSends();
        }
      }

      this.logger.log(`Campaign ${campaignId} finished`);
    } catch (error) {
      // Per-row failures are already handled, so this only fires if the loop
      // itself breaks; the rows already sent stay sent either way.
      this.logger.error(
        `Campaign ${campaignId} aborted: ${describeError(error)}`,
      );
    } finally {
      this.releaseRun();
    }
  }

  /**
   * Drives one row through the state machine:
   * `PENDING → PROCESSING → SENT | FAILED`, with retryable send failures
   * consuming the remaining attempt budget first.
   */
  private async processCandidate(
    candidate: Candidate,
    campaignId: string,
    type: TemplateType,
  ): Promise<void> {
    const { rowNumber, email } = candidate;
    let rendered: RenderedEmail;

    try {
      rendered = this.renderEmail(candidate, type);
    } catch (error) {
      // A template problem is permanent, so the row is settled without ever
      // entering PROCESSING — there is nothing in flight to recover.
      const reason = describeError(error);
      await this.markFailed(
        candidate,
        campaignId,
        reason,
        candidate.attempts + 1,
      );
      this.logger.error(
        `Row ${rowNumber} template failed for ${email}: ${reason}`,
      );
      return;
    }

    await this.markProcessing(candidate, campaignId);

    const maxAttempts = this.getMaxAttempts();
    let attempts = candidate.attempts;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      attempts += 1;

      let messageId: string;

      try {
        const sent = await this.emailService.send({
          to: email,
          subject: rendered.subject,
          body: rendered.body,
          // Threads the follow-up under this message in Phase 4.
          inReplyTo: candidate.messageId ?? undefined,
        });

        messageId = sent.messageId;
      } catch (error) {
        lastError = error;

        const isRetryable =
          classifyEmailError(error) === ERROR_CLASSIFICATION.RETRYABLE;

        if (!isRetryable) {
          this.logger.warn(
            `Row ${rowNumber} attempt ${attempts}/${maxAttempts} failed permanently: ${describeError(error)}`,
          );
          break;
        }

        if (attempts >= maxAttempts) {
          this.logger.warn(
            `Row ${rowNumber} attempt ${attempts}/${maxAttempts} failed retryably, retry budget exhausted: ${describeError(error)}`,
          );
          break;
        }

        this.logger.warn(
          `Row ${rowNumber} attempt ${attempts}/${maxAttempts} failed retryably, retrying: ${describeError(error)}`,
        );
        await this.delayBetweenSends();
        continue;
      }

      // Deliberately outside the try above: the mail is already out, so a
      // failed sheet write must abort the run rather than resend the row. The
      // row stays PROCESSING and stale recovery picks it up.
      await this.googleSheetService.updateRow(rowNumber, {
        [SHEET_COLUMNS.STATUS]: SENT,
        [SHEET_COLUMNS.SENT_AT]: new Date().toISOString(),
        [SHEET_COLUMNS.MESSAGE_ID]: messageId,
        [SHEET_COLUMNS.ERROR]: '',
        [SHEET_COLUMNS.ATTEMPTS]: attempts,
      });

      this.logger.log(
        `Row ${rowNumber} SENT to=${email} attempts=${attempts}/${maxAttempts} messageId=${messageId}`,
      );
      return;
    }

    const reason = describeError(lastError);
    await this.markFailed(candidate, campaignId, reason, attempts);
    this.logger.error(
      `Row ${rowNumber} FAILED to=${email} after ${attempts} attempt(s): ${reason}`,
    );
  }

  /** The pre-send lock. Written before anything is handed to the provider. */
  private async markProcessing(
    candidate: Candidate,
    campaignId: string,
  ): Promise<void> {
    await this.googleSheetService.updateRow(candidate.rowNumber, {
      [SHEET_COLUMNS.STATUS]: PROCESSING,
      [SHEET_COLUMNS.PROCESSING_STARTED_AT]: new Date().toISOString(),
      [SHEET_COLUMNS.CAMPAIGN_ID]: campaignId,
    });
  }

  private async markFailed(
    candidate: Candidate,
    campaignId: string,
    reason: string,
    attempts: number,
  ): Promise<void> {
    await this.googleSheetService.updateRow(candidate.rowNumber, {
      [SHEET_COLUMNS.STATUS]: FAILED,
      [SHEET_COLUMNS.ERROR]: reason,
      [SHEET_COLUMNS.ATTEMPTS]: attempts,
      [SHEET_COLUMNS.CAMPAIGN_ID]: campaignId,
    });
  }

  /** Dry-run path: render, log, and touch nothing in the sheet. */
  private renderOnly(candidate: Candidate, type: TemplateType): SendResultRow {
    const rendered = this.renderEmail(candidate, type);

    const result: SendResultRow = {
      row: candidate.rowNumber,
      email: candidate.email,
      name: candidate.name,
      company: candidate.company,
      role: candidate.role,
      subject: rendered.subject,
      status: 'DRY_RUN',
    };

    this.logger.log(
      `[dry-run] row=${candidate.rowNumber} to=${candidate.email} subject="${rendered.subject}"`,
    );
    this.logger.debug(
      `[dry-run] row=${candidate.rowNumber} body:\n${rendered.body}`,
    );

    return result;
  }

  private renderEmail(candidate: Candidate, type: TemplateType): RenderedEmail {
    return this.templateService.render(
      candidate.role as CandidateRole,
      this.templateService.buildContext(candidate),
      type,
    );
  }

  private buildPreview(
    candidate: Candidate,
    type: TemplateType,
  ): CandidatePreview {
    const rendered = this.renderEmail(candidate, type);

    return {
      row: candidate.rowNumber,
      name: candidate.name,
      email: candidate.email,
      company: candidate.company,
      role: candidate.role,
      type,
      subject: rendered.subject,
      body: rendered.body,
    };
  }

  /**
   * A row is sendable when it passes sheet validation and is either still
   * `PENDING` or a stale `PROCESSING` leftover from a crashed run. Invalid rows
   * are skipped rather than reported again here — `/campaign/validate` is the
   * endpoint for that.
   */
  private async filterEligible(
    candidates: Candidate[],
    filter: { role?: string },
  ): Promise<Candidate[]> {
    const maxAttempts = this.getMaxAttempts();
    const thresholdMinutes = this.getStaleThresholdMinutes();
    const now = Date.now();
    const eligible: Candidate[] = [];
    const exhausted: number[] = [];
    const recovered: number[] = [];

    for (const candidate of candidates) {
      if (filter.role && candidate.role !== filter.role) continue;

      const isStaleRow =
        candidate.status === PROCESSING &&
        isStaleProcessing(candidate, thresholdMinutes, now);
      if (candidate.status !== PENDING && !isStaleRow) continue;

      if (candidate.attempts >= maxAttempts) {
        exhausted.push(candidate.rowNumber);
        continue;
      }

      if ((await validateCandidate(candidate)).length > 0) continue;

      if (isStaleRow) recovered.push(candidate.rowNumber);
      eligible.push(candidate);
    }

    // Skipped rows are never silent: a stuck row is exactly the kind of thing
    // that would otherwise go unnoticed for weeks.
    if (recovered.length > 0) {
      this.logger.warn(
        `Recovering ${recovered.length} stale PROCESSING row(s): ${recovered.join(', ')}`,
      );
    }
    if (exhausted.length > 0) {
      this.logger.warn(
        `Skipping ${exhausted.length} row(s) that already used all ${maxAttempts} attempts: ` +
          `${exhausted.join(', ')}. Reset them to PENDING to retry.`,
      );
    }

    return eligible;
  }

  private acquireRun(): void {
    if (this.isCampaignRunning) {
      throw new ConflictException(
        `A campaign is already running${
          this.activeCampaignId ? ` (${this.activeCampaignId})` : ''
        }. Wait for it to finish, or check GET /campaign/status.`,
      );
    }

    this.isCampaignRunning = true;
  }

  private releaseRun(): void {
    this.isCampaignRunning = false;
    this.activeCampaignId = null;
  }

  /** Total attempts a row may ever make: the first one plus its retries. */
  private getMaxAttempts(): number {
    const retries = this.configService.get<number>(
      'campaign.emailMaxRetries',
      DEFAULT_EMAIL_MAX_RETRIES,
    );

    return Math.max(1, (retries ?? DEFAULT_EMAIL_MAX_RETRIES) + 1);
  }

  private getStaleThresholdMinutes(): number {
    return (
      this.configService.get<number>(
        'campaign.staleProcessingThresholdMinutes',
        DEFAULT_STALE_PROCESSING_THRESHOLD_MINUTES,
      ) ?? DEFAULT_STALE_PROCESSING_THRESHOLD_MINUTES
    );
  }

  private delayBetweenSends(): Promise<void> {
    const delayMs =
      this.configService.get<number>(
        'campaign.emailDelayMs',
        DEFAULT_EMAIL_DELAY_MS,
      ) ?? DEFAULT_EMAIL_DELAY_MS;

    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function summarize(candidates: Candidate[]): CampaignCounts {
  const byStatus = new Map<CandidateStatus, number>();

  for (const candidate of candidates) {
    const status = candidate.status as CandidateStatus;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  return {
    total: candidates.length,
    pending: byStatus.get('PENDING') ?? 0,
    processing: byStatus.get('PROCESSING') ?? 0,
    sent: byStatus.get('SENT') ?? 0,
    failed: byStatus.get('FAILED') ?? 0,
  };
}

function summarizeFollowUp(candidates: Candidate[]): FollowUpCounts {
  const byStatus = new Map<string, number>();
  let enabled = 0;

  for (const candidate of candidates) {
    byStatus.set(
      candidate.followUpStatus,
      (byStatus.get(candidate.followUpStatus) ?? 0) + 1,
    );
    if (candidate.followUpEnabled === 'YES') enabled += 1;
  }

  return {
    notScheduled: byStatus.get('NOT_SCHEDULED') ?? 0,
    scheduled: byStatus.get('SCHEDULED') ?? 0,
    processing: byStatus.get('PROCESSING') ?? 0,
    sent: byStatus.get('SENT') ?? 0,
    failed: byStatus.get('FAILED') ?? 0,
    enabled,
  };
}

async function validateCandidate(
  candidate: Candidate,
): Promise<SheetValidationReport['errors']> {
  const validationErrors = await validate(candidate, VALIDATION_OPTIONS);
  const { rowNumber } = candidate;

  return validationErrors.flatMap((error) =>
    flattenValidationError(rowNumber, error),
  );
}

function flattenValidationError(
  rowNumber: number,
  error: ValidationError,
): SheetValidationReport['errors'] {
  const own: SheetValidationReport['errors'] = Object.values(
    error.constraints ?? {},
  ).map((message) => ({ row: rowNumber, field: error.property, message }));

  const nested = (error.children ?? []).flatMap((child) =>
    flattenValidationError(rowNumber, child),
  );

  return [...own, ...nested];
}
