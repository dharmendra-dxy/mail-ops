import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate, ValidationError } from 'class-validator';
import { EmailService } from '../email';
import {
  Candidate,
  CandidateRole,
  CandidateStatus,
  GoogleSheetService,
  SHEET_COLUMNS,
} from '../google-sheet';
import { RenderedEmail, TemplateService, TemplateType } from '../template';
import {
  CampaignCounts,
  CampaignPreviewResponse,
  CampaignSendResponse,
  CandidatePreview,
  ConnectSheetResponse,
  SendResultRow,
  SheetValidationReport,
} from './campaign.types';
import { PreviewCandidatesDto } from './dto/preview-candidates.dto';
import { SendCampaignDto } from './dto/send-campaign.dto';

const VALIDATION_OPTIONS = {
  whitelist: false,
  forbidUnknownValues: false,
  validationError: { target: false, value: false },
};

const PENDING: CandidateStatus = 'PENDING';

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

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

  /**
   * Sends (or, in dry-run, only renders) one email per eligible row, strictly
   * sequentially.
   *
   * Phase 2 scope: each row is attempted independently and the outcome is
   * written back immediately, but there is no PROCESSING guard, campaign lock
   * or retry budget yet — those arrive with the Phase 3 state machine.
   */
  async send(dto: SendCampaignDto): Promise<CampaignSendResponse> {
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

    this.logger.log(
      `${dryRun ? 'Dry run' : 'Sending'} for ${eligible.length} candidate(s)` +
        `${dto.role ? ` (role=${dto.role})` : ''}`,
    );

    const results: SendResultRow[] = [];

    for (const [index, candidate] of eligible.entries()) {
      results.push(
        dryRun
          ? this.renderOnly(candidate, dto.type)
          : await this.sendOne(candidate, dto.type),
      );

      if (!dryRun && index < eligible.length - 1) {
        await this.delayBetweenSends();
      }
    }

    return {
      connection,
      dryRun,
      // The full eligible count, so a limit that cut the batch short is visible
      // in the response and not only in the logs.
      eligible: allEligible.length,
      processed: results.length,
      sent: results.filter((result) => result.status === 'SENT').length,
      failed: results.filter((result) => result.status === 'FAILED').length,
      results,
    };
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

  /**
   * One real send. The row is settled before moving on, so a failure here can
   * never take the rest of the batch with it.
   */
  private async sendOne(
    candidate: Candidate,
    type: TemplateType,
  ): Promise<SendResultRow> {
    const rendered = this.renderEmail(candidate, type);

    const base: Omit<SendResultRow, 'status'> = {
      row: candidate.rowNumber,
      email: candidate.email,
      name: candidate.name,
      company: candidate.company,
      role: candidate.role,
      subject: rendered.subject,
    };

    try {
      const sent = await this.emailService.send({
        to: candidate.email,
        subject: rendered.subject,
        body: rendered.body,
        // Threads the follow-up under this message in Phase 4.
        inReplyTo: candidate.messageId ?? undefined,
      });

      await this.googleSheetService.updateRow(candidate.rowNumber, {
        [SHEET_COLUMNS.STATUS]: 'SENT',
        [SHEET_COLUMNS.SENT_AT]: new Date().toISOString(),
        [SHEET_COLUMNS.MESSAGE_ID]: sent.messageId,
        [SHEET_COLUMNS.ERROR]: '',
        [SHEET_COLUMNS.ATTEMPTS]: candidate.attempts + 1,
      });

      this.logger.log(
        `Sent row=${candidate.rowNumber} to=${candidate.email} messageId=${sent.messageId}`,
      );

      return { ...base, status: 'SENT', messageId: sent.messageId };
    } catch (error) {
      const reason = describeError(error);

      await this.googleSheetService.updateRow(candidate.rowNumber, {
        [SHEET_COLUMNS.STATUS]: 'FAILED',
        [SHEET_COLUMNS.ERROR]: reason,
        [SHEET_COLUMNS.ATTEMPTS]: candidate.attempts + 1,
      });

      this.logger.error(
        `Failed row=${candidate.rowNumber} to=${candidate.email}: ${reason}`,
      );

      return { ...base, status: 'FAILED', error: reason };
    }
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
   * A row is sendable when it passes sheet validation and is still PENDING.
   * Invalid rows are skipped rather than reported again here — `/campaign/validate`
   * is the endpoint for that.
   */
  private async filterEligible(
    candidates: Candidate[],
    filter: { role?: string },
  ): Promise<Candidate[]> {
    const eligible: Candidate[] = [];

    for (const candidate of candidates) {
      if (filter.role && candidate.role !== filter.role) continue;
      if (candidate.status !== PENDING) continue;
      if ((await validateCandidate(candidate)).length > 0) continue;

      eligible.push(candidate);
    }

    return eligible;
  }

  private delayBetweenSends(): Promise<void> {
    const delayMs = this.configService.get<number>(
      'campaign.emailDelayMs',
      2000,
    );

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

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // Provider errors are often multi-line (SMTP replies quote a support URL);
  // the sheet cell only needs the first meaningful line.
  return message.replace(/\s+/g, ' ').trim();
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
