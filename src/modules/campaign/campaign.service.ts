import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate, ValidationError } from 'class-validator';
import { formatLogEvent } from '../../common/logger/log-event.util';
import { EmailService } from '../email';
import {
  Candidate,
  CandidateRole,
  CandidateStatus,
  GoogleSheetService,
  SHEET_COLUMNS,
  SheetConnection,
} from '../google-sheet';
import {
  RenderedEmail,
  TEMPLATE_TYPES,
  TemplateService,
  TemplateType,
} from '../template';
import {
  CAMPAIGN_RUN_STATUS,
  DEFAULT_EMAIL_DELAY_MS,
  DEFAULT_EMAIL_MAX_RETRIES,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_STALE_PROCESSING_THRESHOLD_MINUTES,
  ERROR_CLASSIFICATION,
  FAILED,
  FOLLOW_UP_FAILED,
  FOLLOW_UP_NOT_SCHEDULED,
  FOLLOW_UP_PROCESSING,
  FOLLOW_UP_SCHEDULED,
  FOLLOW_UP_SENT,
  PENDING,
  PROCESSING,
  SENT,
} from './campaign.constant';
import {
  BatchRunResult,
  CampaignCounts,
  CampaignPreviewResponse,
  CampaignRunResponse,
  CampaignSendResponse,
  CampaignStatusResponse,
  CandidatePreview,
  ConnectSheetResponse,
  DailyCycleResult,
  FollowUpCounts,
  ScheduledRunOptions,
  SendResultRow,
  SheetValidationReport,
  SKIP_REASON,
} from './campaign.types';
import {
  classifyEmailError,
  describeError,
  formatDryRunCampaignId,
  followUpDueAt,
  isFollowUpDue,
  isStaleFollowUpProcessing,
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

/** Which columns of a row a batch writes, so both paths log the same way. */
type SendKind = 'initial' | 'follow-up';

type SendOutcome =
  | { ok: true; messageId: string; attempts: number }
  | { ok: false; reason: string; attempts: number };

@Injectable()
export class CampaignService implements OnApplicationShutdown {
  private readonly logger = new Logger(CampaignService.name);

  /**
   * Single-run guard. V1 is deliberately single-instance, so an in-memory flag
   * is enough to stop two overlapping batches from sending the same row twice.
   */
  private isCampaignRunning = false;
  private activeCampaignId: string | null = null;

  /**
   * The in-flight run, kept so shutdown can wait for it. `spawnRun` is
   * deliberately detached (a 50-row batch must not hold the HTTP request open),
   * which is exactly why an un-awaited batch would otherwise be killed
   * mid-send on SIGTERM.
   */
  private activeRun: Promise<void> | null = null;
  private isDraining = false;

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
    if (this.isDraining) {
      // Shutting down. Refusing here is better than accepting a run that would
      // be killed before it settled, which is a row left in PROCESSING.
      throw new ConflictException(
        'The app is shutting down and is not accepting new campaigns. Try again once it is back.',
      );
    }

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
        formatLogEvent('campaign.limit_reached', {
          limit: dto.limit,
          eligible: allEligible.length,
          deferred: allEligible.length - eligible.length,
        }),
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

    // Ownership of the lock moves to the background run, which releases it.
    this.activeRun = this.spawnRun(
      { role: dto.role, type: dto.type },
      { campaignId, eligible },
    );
    void this.activeRun;

    return {
      connection,
      status: CAMPAIGN_RUN_STATUS.STARTED,
      campaignId,
      dryRun: false,
      total: eligible.length,
    };
  }

  /**
   * Detached run for `POST /campaign/send`. The caller already holds the lock
   * and has already read the sheet, so the resolved batch is handed over as-is:
   * a second read would cost an extra Sheet call per campaign and could return
   * a different row set than the one the response counted.
   */
  private async spawnRun(
    options: ScheduledRunOptions,
    preset: { campaignId: string; eligible: Candidate[] },
  ): Promise<void> {
    try {
      await this.runInitialBatch(options, preset);
    } catch (error) {
      // Stamping the batch can fail before the row loop starts; without this
      // the run would silently keep the lock forever.
      this.logger.error(
        formatLogEvent('campaign.aborted_before_sending', {
          campaignId: preset.campaignId,
          reason: describeError(error),
        }),
      );
    } finally {
      this.releaseRun();
      this.activeRun = null;
    }
  }

  /**
   * Waits for the detached batch to settle before the process exits.
   *
   * Without this a `Ctrl-C` or a deploy during a batch kills the process between
   * `PROCESSING` being written and `SENT`, so the row is only recoverable
   * through stale-`PROCESSING` recovery 30 minutes later. Draining turns a
   * normal restart into a clean stop; the timeout exists only so a hung
   * provider cannot block shutdown forever.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.isDraining = true;

    const run = this.activeRun;
    if (!run) return;

    const timeoutMs =
      this.configService.get<number>('campaign.shutdownDrainTimeoutMs') ??
      DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;

    this.logger.log(
      formatLogEvent('shutdown.drain.started', {
        signal: signal ?? 'unknown',
        campaignId: this.activeCampaignId,
        timeoutMs,
      }),
    );

    const drained = await this.waitFor(run, timeoutMs);

    this.logger.log(
      drained
        ? formatLogEvent('shutdown.drain.completed', {
            campaignId: this.activeCampaignId,
          })
        : formatLogEvent('shutdown.drain.timed_out', {
            campaignId: this.activeCampaignId,
            timeoutMs,
            note: 'an in-flight row stays PROCESSING and is recovered by stale-processing detection',
          }),
    );
  }

  /** Resolves false when the run outlives the timeout, without rejecting. */
  private async waitFor(
    run: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    try {
      return await Promise.race([
        run.then(
          () => true,
          () => true, // A failed run is still settled; there is nothing to wait for.
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The single daily cycle: due initial emails first, then due follow-ups.
   * One lock covers both so a follow-up can never start while an initial batch
   * is still settling rows.
   */
  async runDailyCycle(
    options: ScheduledRunOptions = {},
  ): Promise<DailyCycleResult> {
    const startedAt = new Date().toISOString();

    if (!this.tryAcquireRun()) {
      this.logger.warn(
        formatLogEvent('cycle.skipped', {
          reason: SKIP_REASON.RUN_IN_PROGRESS,
          activeCampaignId: this.activeCampaignId,
        }),
      );

      return this.buildCycleResult(startedAt, SKIP_REASON.RUN_IN_PROGRESS);
    }

    this.logger.log(
      formatLogEvent('cycle.started', {
        limit: options.limit,
        role: options.role,
      }),
    );

    try {
      const initial = await this.runInitialBatch(options);
      const followUp = await this.runFollowUpBatch(options);

      const result = this.buildCycleResult(startedAt, null, initial, followUp);
      this.logger.log(
        formatLogEvent('cycle.finished', {
          initialSent: initial.sent,
          initialFailed: initial.failed,
          followUpSent: followUp.sent,
          followUpFailed: followUp.failed,
          promoted: result.promoted,
          durationMs:
            Date.parse(result.finishedAt) - Date.parse(result.startedAt),
        }),
      );

      return result;
    } finally {
      this.releaseRun();
    }
  }

  /**
   * Sends every due initial email. Used by the daily cycle and available for
   * scripts; returns `skipped` instead of throwing when a run already holds the
   * lock, because a cron tick must never take the process down.
   */
  async processScheduledEmails(
    options: ScheduledRunOptions = {},
  ): Promise<BatchRunResult> {
    if (!this.tryAcquireRun()) {
      this.logger.warn(
        formatLogEvent('batch.skipped', {
          kind: 'initial',
          reason: SKIP_REASON.RUN_IN_PROGRESS,
        }),
      );
      return this.buildBatchResult(SKIP_REASON.RUN_IN_PROGRESS);
    }

    try {
      return await this.runInitialBatch(options);
    } finally {
      this.releaseRun();
    }
  }

  /**
   * Sends every due follow-up. Follow-ups run in their own `PROCESSING` state
   * and their own columns, so an initial failure can never block one and vice
   * versa.
   */
  async processFollowUps(
    options: ScheduledRunOptions = {},
  ): Promise<BatchRunResult> {
    if (!this.tryAcquireRun()) {
      this.logger.warn(
        formatLogEvent('batch.skipped', {
          kind: 'follow-up',
          reason: SKIP_REASON.RUN_IN_PROGRESS,
        }),
      );
      return this.buildBatchResult(SKIP_REASON.RUN_IN_PROGRESS);
    }

    try {
      return await this.runFollowUpBatch(options);
    } finally {
      this.releaseRun();
    }
  }

  /** Initial-email half of a run. The caller must already hold the lock. */
  private async runInitialBatch(
    options: ScheduledRunOptions,
    preset?: { campaignId: string; eligible: Candidate[] },
  ): Promise<BatchRunResult> {
    const batch = preset ?? (await this.resolveInitialBatch(options));

    if (batch.eligible.length === 0) {
      this.logger.debug(formatLogEvent('batch.empty', { kind: 'initial' }));
      return this.buildBatchResult(null, 0);
    }

    this.activeCampaignId = batch.campaignId;
    this.logger.log(
      formatLogEvent('campaign.started', {
        campaignId: batch.campaignId,
        candidates: batch.eligible.length,
        role: options.role,
        type: options.type ?? TEMPLATE_TYPES.INITIAL,
      }),
    );

    return this.executeCampaign(
      batch.campaignId,
      batch.eligible,
      options.type ?? TEMPLATE_TYPES.INITIAL,
    );
  }

  /** Reads the sheet and picks the rows a fresh batch should send. */
  private async resolveInitialBatch(
    options: ScheduledRunOptions,
  ): Promise<{ campaignId: string; eligible: Candidate[] }> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);
    const allEligible = await this.filterEligible(candidates, {
      role: options.role,
    });
    const eligible = this.capBatch(allEligible, options.limit, 'initial email');

    return {
      campaignId: nextCampaignId(
        candidates.map((candidate) => candidate.campaignId),
        new Date(),
      ),
      eligible,
    };
  }

  /** Follow-up half of a run. The caller must already hold the lock. */
  private async runFollowUpBatch(
    options: ScheduledRunOptions,
  ): Promise<BatchRunResult> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);
    const promoted = await this.promoteScheduledFollowUps(candidates);
    const due = await this.filterDueFollowUps(candidates);
    const eligible = this.capBatch(due, options.limit, 'follow-up');

    if (eligible.length === 0) {
      this.logger.debug(formatLogEvent('batch.empty', { kind: 'follow-up' }));
      return { ...this.buildBatchResult(null, 0), promoted };
    }

    const campaignId = nextCampaignId(
      candidates.map((candidate) => candidate.campaignId),
      new Date(),
    );
    this.activeCampaignId = campaignId;

    this.logger.log(
      formatLogEvent('followup.started', {
        campaignId,
        rows: eligible.length,
        promoted,
      }),
    );

    return {
      ...(await this.executeFollowUpCampaign(campaignId, eligible)),
      promoted,
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
      this.logger.log(
        formatLogEvent('dryrun.started', {
          candidates: eligible.length,
          type,
        }),
      );

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
   * Runs one initial-email campaign to completion. Each row is settled before
   * the next one starts, so a single failure can never take the batch with it.
   */
  private async executeCampaign(
    campaignId: string,
    candidates: Candidate[],
    type: TemplateType,
  ): Promise<BatchRunResult> {
    const result = this.buildBatchResult(null, candidates.length, campaignId);

    try {
      for (const [index, candidate] of candidates.entries()) {
        const sent = await this.processCandidate(candidate, campaignId, type);
        this.countResult(result, sent);

        if (index < candidates.length - 1) {
          await this.delayBetweenSends();
        }
      }

      this.logger.log(
        formatLogEvent('campaign.finished', {
          campaignId,
          sent: result.sent,
          failed: result.failed,
        }),
      );
    } catch (error) {
      // Per-row failures are already handled, so this only fires if the loop
      // itself breaks; the rows already sent stay sent either way.
      this.logger.error(
        formatLogEvent('campaign.aborted', {
          campaignId,
          reason: describeError(error),
        }),
      );
    }

    return result;
  }

  /** Follow-up counterpart of `executeCampaign`. */
  private async executeFollowUpCampaign(
    campaignId: string,
    candidates: Candidate[],
  ): Promise<BatchRunResult> {
    const result = this.buildBatchResult(null, candidates.length, campaignId);

    try {
      for (const [index, candidate] of candidates.entries()) {
        const sent = await this.processFollowUpCandidate(candidate, campaignId);
        this.countResult(result, sent);

        if (index < candidates.length - 1) {
          await this.delayBetweenSends();
        }
      }

      this.logger.log(
        formatLogEvent('followup.finished', {
          campaignId,
          sent: result.sent,
          failed: result.failed,
        }),
      );
    } catch (error) {
      this.logger.error(
        formatLogEvent('followup.aborted', {
          campaignId,
          reason: describeError(error),
        }),
      );
    }

    return result;
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
  ): Promise<boolean> {
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
        formatLogEvent('candidate.template_failed', {
          row: rowNumber,
          to: email,
          kind: 'initial',
          reason,
        }),
      );
      return false;
    }

    await this.markProcessing(candidate, campaignId);

    const maxAttempts = this.getMaxAttempts();
    const outcome = await this.sendWithRetry({
      rowNumber,
      email,
      kind: 'initial',
      subject: rendered.subject,
      body: rendered.body,
      attempts: candidate.attempts,
      maxAttempts,
    });

    if (!outcome.ok) {
      await this.markFailed(
        candidate,
        campaignId,
        outcome.reason,
        outcome.attempts,
      );
      this.logger.error(
        formatLogEvent('candidate.failed', {
          row: rowNumber,
          to: email,
          kind: 'initial',
          campaignId,
          attempt: outcome.attempts,
          maxAttempts,
          reason: outcome.reason,
        }),
      );
      return false;
    }

    // Deliberately outside the send path: the mail is already out, so a
    // failed sheet write must abort the run rather than resend the row. The
    // row stays PROCESSING and stale recovery picks it up.
    await this.googleSheetService.updateRow(rowNumber, {
      [SHEET_COLUMNS.STATUS]: SENT,
      [SHEET_COLUMNS.SENT_AT]: new Date().toISOString(),
      [SHEET_COLUMNS.MESSAGE_ID]: outcome.messageId,
      [SHEET_COLUMNS.ERROR]: '',
      [SHEET_COLUMNS.ATTEMPTS]: outcome.attempts,
    });

    this.logger.log(
      formatLogEvent('candidate.sent', {
        row: rowNumber,
        to: email,
        company: candidate.company,
        role: candidate.role,
        campaignId,
        attempt: outcome.attempts,
        maxAttempts,
        messageId: outcome.messageId,
      }),
    );
    return true;
  }

  /**
   * Follow-up equivalent of `processCandidate`. It threads the mail under the
   * original message id and writes only follow-up columns, so the initial
   * record in the sheet stays exactly as it was.
   */
  private async processFollowUpCandidate(
    candidate: Candidate,
    campaignId: string,
  ): Promise<boolean> {
    const { rowNumber, email } = candidate;
    let rendered: RenderedEmail;

    try {
      rendered = this.renderEmail(candidate, TEMPLATE_TYPES.FOLLOW_UP);
    } catch (error) {
      const reason = describeError(error);
      await this.markFollowUpFailed(candidate, campaignId, reason);
      this.logger.error(
        formatLogEvent('candidate.template_failed', {
          row: rowNumber,
          to: email,
          kind: 'follow-up',
          reason,
        }),
      );
      return false;
    }

    await this.markFollowUpProcessing(candidate, campaignId);

    const outcome = await this.sendWithRetry({
      rowNumber,
      email,
      kind: 'follow-up',
      subject: rendered.subject,
      body: rendered.body,
      inReplyTo: candidate.messageId ?? undefined,
      // Follow-up attempts are counted per run, not in the shared `attempts`
      // column, which is the initial email's own budget.
      attempts: 0,
      maxAttempts: this.getMaxAttempts(),
    });

    if (!outcome.ok) {
      await this.markFollowUpFailed(candidate, campaignId, outcome.reason);
      this.logger.error(
        formatLogEvent('candidate.failed', {
          row: rowNumber,
          to: email,
          kind: 'follow-up',
          campaignId,
          attempt: outcome.attempts,
          reason: outcome.reason,
        }),
      );
      return false;
    }

    await this.googleSheetService.updateRow(rowNumber, {
      [SHEET_COLUMNS.FOLLOW_UP_STATUS]: FOLLOW_UP_SENT,
      [SHEET_COLUMNS.FOLLOW_UP_SENT_AT]: new Date().toISOString(),
      [SHEET_COLUMNS.FOLLOW_UP_MESSAGE_ID]: outcome.messageId,
      [SHEET_COLUMNS.ERROR]: '',
    });

    this.logger.log(
      formatLogEvent('candidate.sent', {
        row: rowNumber,
        to: email,
        kind: 'follow-up',
        campaignId,
        attempt: outcome.attempts,
        messageId: outcome.messageId,
      }),
    );
    return true;
  }

  /**
   * The provider call plus its in-place retries, shared by both paths so the
   * classification rules cannot drift apart. It never writes to the sheet: the
   * caller owns the state transition, which keeps "the mail is out but the
   * write failed" distinguishable from a send failure.
   */
  private async sendWithRetry(params: {
    rowNumber: number;
    email: string;
    kind: SendKind;
    subject: string;
    body: string;
    inReplyTo?: string;
    attempts: number;
    maxAttempts: number;
  }): Promise<SendOutcome> {
    const { rowNumber, email, kind, maxAttempts } = params;
    let attempts = params.attempts;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      attempts += 1;

      try {
        const sent = await this.emailService.send({
          to: email,
          subject: params.subject,
          body: params.body,
          inReplyTo: params.inReplyTo,
        });

        return { ok: true, messageId: sent.messageId, attempts };
      } catch (error) {
        lastError = error;

        const isRetryable =
          classifyEmailError(error) === ERROR_CLASSIFICATION.RETRYABLE;

        const attemptFields = {
          row: rowNumber,
          to: email,
          kind,
          attempt: attempts,
          maxAttempts,
          reason: describeError(error),
        };

        if (!isRetryable) {
          this.logger.warn(
            formatLogEvent('send.attempt.permanent_failure', attemptFields),
          );
          break;
        }

        if (attempts >= maxAttempts) {
          this.logger.warn(
            formatLogEvent('send.attempt.budget_exhausted', attemptFields),
          );
          break;
        }

        this.logger.warn(
          formatLogEvent('send.attempt.retrying', attemptFields),
        );
        await this.delayBetweenSends();
      }
    }

    return { ok: false, reason: describeError(lastError), attempts };
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

  /** Follow-up pre-send lock. `processing_started_at` is shared, not duplicated. */
  private async markFollowUpProcessing(
    candidate: Candidate,
    campaignId: string,
  ): Promise<void> {
    await this.googleSheetService.updateRow(candidate.rowNumber, {
      [SHEET_COLUMNS.FOLLOW_UP_STATUS]: FOLLOW_UP_PROCESSING,
      [SHEET_COLUMNS.PROCESSING_STARTED_AT]: new Date().toISOString(),
      [SHEET_COLUMNS.CAMPAIGN_ID]: campaignId,
    });
  }

  private async markFollowUpFailed(
    candidate: Candidate,
    campaignId: string,
    reason: string,
  ): Promise<void> {
    await this.googleSheetService.updateRow(candidate.rowNumber, {
      [SHEET_COLUMNS.FOLLOW_UP_STATUS]: FOLLOW_UP_FAILED,
      [SHEET_COLUMNS.ERROR]: reason,
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
      formatLogEvent('dryrun.rendered', {
        row: candidate.rowNumber,
        to: candidate.email,
        role: candidate.role,
        subject: rendered.subject,
      }),
    );
    // The body is only useful at `debug`, where the operator opted in: at
    // `log` level a 50-row dry run would print 50 full emails.
    this.logger.debug(
      formatLogEvent('dryrun.body', {
        row: candidate.rowNumber,
        body: rendered.body,
      }),
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
        formatLogEvent('batch.recovered_stale', {
          count: recovered.length,
          rows: recovered.join(','),
          thresholdMinutes,
        }),
      );
    }
    if (exhausted.length > 0) {
      this.logger.warn(
        formatLogEvent('batch.skipped_exhausted', {
          count: exhausted.length,
          rows: exhausted.join(','),
          maxAttempts,
          reason: 'reset them to PENDING to retry',
        }),
      );
    }

    return eligible;
  }

  /**
   * Moves `NOT_SCHEDULED` rows to `SCHEDULED` as soon as the initial email is
   * on record, so the sheet shows the queue before anything fires. It is a
   * separate write from the send, so the promotion is visible even on a day
   * where the follow-up is not due yet.
   */
  private async promoteScheduledFollowUps(
    candidates: Candidate[],
  ): Promise<number> {
    const promoted: number[] = [];

    for (const candidate of candidates) {
      if (!this.isFollowUpOptedIn(candidate)) continue;
      if (candidate.followUpStatus !== FOLLOW_UP_NOT_SCHEDULED) continue;
      // No usable timing means no commitment to make yet; `filterDueFollowUps`
      // reports the row as unreadable on the same cycle.
      if (followUpDueAt(candidate) === null) continue;

      await this.googleSheetService.updateRow(candidate.rowNumber, {
        [SHEET_COLUMNS.FOLLOW_UP_STATUS]: FOLLOW_UP_SCHEDULED,
      });
      // Kept in step with the in-memory copy so the same cycle can act on the
      // row without reading the sheet again.
      candidate.followUpStatus = FOLLOW_UP_SCHEDULED;
      promoted.push(candidate.rowNumber);
    }

    if (promoted.length > 0) {
      this.logger.log(
        formatLogEvent('followup.scheduled', {
          count: promoted.length,
          rows: promoted.join(','),
        }),
      );
    }

    return promoted.length;
  }

  /**
   * A follow-up may only go out when the initial email is known to be `SENT`.
   * Anything else is skipped quietly: it is either not opted in, not a valid
   * row, or simply not the follow-up's turn yet.
   */
  private async filterDueFollowUps(
    candidates: Candidate[],
  ): Promise<Candidate[]> {
    const thresholdMinutes = this.getStaleThresholdMinutes();
    const now = Date.now();
    const due: Candidate[] = [];
    const recovered: number[] = [];
    const undated: number[] = [];
    const stuck: number[] = [];

    for (const candidate of candidates) {
      if (!this.isFollowUpOptedIn(candidate)) continue;

      if (followUpDueAt(candidate) === null) {
        undated.push(candidate.rowNumber);
        continue;
      }

      if (candidate.followUpStatus === FOLLOW_UP_SENT) continue;

      if (candidate.followUpStatus === FOLLOW_UP_FAILED) {
        // Never resent automatically: the row stays failed until a human puts
        // it back to SCHEDULED. An unbounded daily retry loop is exactly the
        // behaviour that gets an outreach domain throttled.
        stuck.push(candidate.rowNumber);
        continue;
      }

      if (candidate.followUpStatus === FOLLOW_UP_PROCESSING) {
        if (!isStaleFollowUpProcessing(candidate, thresholdMinutes, now)) {
          continue;
        }
        recovered.push(candidate.rowNumber);
      }

      if (!isFollowUpDue(candidate, now)) continue;

      // A row with a broken email or role is not sendable at all; the follow-up
      // filter must not be a second, quieter way to mail invalid rows.
      if ((await validateCandidate(candidate)).length > 0) continue;

      due.push(candidate);
    }

    if (recovered.length > 0) {
      this.logger.warn(
        formatLogEvent('followup.recovered_stale', {
          count: recovered.length,
          rows: recovered.join(','),
        }),
      );
    }
    if (undated.length > 0) {
      this.logger.warn(
        formatLogEvent('followup.skipped_undated', {
          count: undated.length,
          rows: undated.join(','),
          reason: 'unusable sent_at or follow_up_days',
        }),
      );
    }
    if (stuck.length > 0) {
      this.logger.warn(
        formatLogEvent('followup.skipped_failed', {
          count: stuck.length,
          rows: stuck.join(','),
          reason: 'set follow_up_status back to SCHEDULED to retry',
        }),
      );
    }

    return due;
  }

  /**
   * A follow-up is only ever considered for a row that opted in *and* whose
   * initial email is already `SENT`: a follow-up before the first email makes
   * no sense and would double-contact someone who never got the intro.
   */
  private isFollowUpOptedIn(candidate: Candidate): boolean {
    return candidate.status === SENT && candidate.followUpEnabled === 'YES';
  }

  private acquireRun(): void {
    if (!this.tryAcquireRun()) {
      throw new ConflictException(
        `A campaign is already running${
          this.activeCampaignId ? ` (${this.activeCampaignId})` : ''
        }. Wait for it to finish, or check GET /campaign/status.`,
      );
    }
  }

  /** Non-throwing acquire: the cron path skips a cycle instead of failing. */
  private tryAcquireRun(): boolean {
    if (this.isCampaignRunning) return false;

    this.isCampaignRunning = true;
    return true;
  }

  private releaseRun(): void {
    this.isCampaignRunning = false;
    this.activeCampaignId = null;
  }

  /** Applies the batch cap, and says so loudly when rows are left behind. */
  private capBatch(
    eligible: Candidate[],
    limit: number | undefined,
    label: string,
  ): Candidate[] {
    if (!limit || limit >= eligible.length) return eligible;

    this.logger.warn(
      formatLogEvent('campaign.batch_limit_reached', {
        label,
        limit,
        due: eligible.length,
        deferred: eligible.length - limit,
      }),
    );

    return eligible.slice(0, limit);
  }

  private buildBatchResult(
    skipped: BatchRunResult['skipped'],
    eligible = 0,
    campaignId: string | null = null,
  ): BatchRunResult {
    return {
      campaignId,
      eligible,
      processed: 0,
      sent: 0,
      failed: 0,
      skipped,
      promoted: 0,
    };
  }

  private countResult(result: BatchRunResult, sent: boolean): void {
    result.processed += 1;
    if (sent) result.sent += 1;
    else result.failed += 1;
  }

  private buildCycleResult(
    startedAt: string,
    skipped: DailyCycleResult['skipped'],
    initial?: BatchRunResult,
    followUp?: BatchRunResult,
  ): DailyCycleResult {
    const empty = this.buildBatchResult(skipped);

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      skipped,
      initial: initial ?? empty,
      followUp: followUp ?? empty,
      promoted: followUp?.promoted ?? 0,
    };
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
