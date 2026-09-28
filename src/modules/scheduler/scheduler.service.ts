import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CampaignService, describeError } from '../campaign';
import {
  DEFAULT_CRON_BATCH_LIMIT,
  DEFAULT_CRON_HOUR,
  DEFAULT_CRON_JOB_NAME,
  DEFAULT_CRON_MINUTE,
  DEFAULT_CRON_TIMEZONE,
} from './scheduler.constant';
import { SchedulerRunResponse, SchedulerStatus } from './scheduler.types';

interface CronSettings {
  enabled: boolean;
  jobName: string;
  expression: string;
  timezone: string;
  batchLimit: number;
}

/**
 * Owns the single daily cron entry point.
 *
 * The job is registered at `onModuleInit` from the environment and never
 * declared with `@Cron()`: when `CRON_ENABLED` is false there is no job object
 * in the registry at all, rather than a job that wakes up and does nothing.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private job: CronJob | null = null;
  private lastRun: SchedulerStatus['lastRun'] = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  constructor(
    private readonly campaignService: CampaignService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const settings = this.getSettings();

    if (!settings.enabled) {
      // Not a warning: leaving cron off is the safe default for local work.
      this.logger.log(
        'Cron is disabled (CRON_ENABLED=false) — no job registered. ' +
          'POST /api/scheduler/run still triggers a cycle on demand.',
      );
      return;
    }

    // The registry key is the job name; `CronJob` itself takes no name.
    // The tick deliberately drops the promise: cron does not await it, and
    // `runCycle` already swallows its own failures.
    const job = new CronJob(
      settings.expression,
      () => {
        void this.runCycle('CRON');
      },
      undefined,
      true,
      settings.timezone,
    );

    this.schedulerRegistry.addCronJob(settings.jobName, job);
    this.job = job;

    this.logger.log(
      `Cron registered: "${settings.expression}" (${settings.timezone}) as ` +
        `"${settings.jobName}", batch limit ${settings.batchLimit}. ` +
        'Next tick runs initial emails, then follow-ups.',
    );
  }

  onModuleDestroy(): void {
    if (!this.job) return;

    // `deleteCronJob` only forgets the job; the timer itself has to be stopped,
    // or a shutting-down process would keep ticking. The existence check
    // matters because another shutdown hook may have cleared the registry first.
    this.job.stop();
    this.job = null;

    const jobName = this.getSettings().jobName;
    if (this.schedulerRegistry.doesExist('cron', jobName)) {
      this.schedulerRegistry.deleteCronJob(jobName);
    }
  }

  getStatus(): SchedulerStatus {
    const settings = this.getSettings();

    return {
      enabled: settings.enabled,
      registered: this.job !== null,
      jobName: this.job ? settings.jobName : null,
      expression: this.job ? settings.expression : null,
      timezone: this.job ? settings.timezone : null,
      batchLimit: settings.batchLimit,
      lastRunAt: this.lastRunAt,
      lastRun: this.lastRun,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
    };
  }

  /**
   * Manual entry point, so the daily cycle can be proven without waiting for the
   * clock. It obeys the same single-run lock as the cron tick.
   */
  async runNow(): Promise<SchedulerRunResponse> {
    return this.runCycle('MANUAL');
  }

  private async runCycle(
    trigger: SchedulerRunResponse['trigger'],
  ): Promise<SchedulerRunResponse> {
    const settings = this.getSettings();

    try {
      const result = await this.campaignService.runDailyCycle({
        limit: settings.batchLimit,
      });

      this.lastRun = result;
      this.lastRunAt = new Date().toISOString();

      this.logger.log(
        `${trigger} cycle ${result.skipped ?? 'completed'}: ` +
          `initial ${result.initial.sent}/${result.initial.eligible} sent, ` +
          `follow-ups ${result.followUp.sent}/${result.followUp.eligible} sent`,
      );

      return { trigger, result, skipped: result.skipped, error: null };
    } catch (error) {
      // A cron callback has no caller to reject to: an unhandled rejection here
      // would take the whole process down on a single sheet outage, so the
      // failure is recorded and swallowed. A manual trigger rethrows instead,
      // because there the HTTP caller should see the error.
      this.lastError = describeError(error);
      this.lastErrorAt = new Date().toISOString();
      this.logger.error(`${trigger} cycle failed: ${this.lastError}`);

      if (trigger === 'MANUAL') throw error;

      return { trigger, result: null, skipped: null, error: this.lastError };
    }
  }

  /**
   * Read through `ConfigService` so nothing here depends on `process.env`.
   * `cron.config` always supplies the expression; the hour/minute pair is only a
   * safety net for a bare `ConfigService` in a test.
   */
  private getSettings(): CronSettings {
    const hour = this.configService.get<number>('cron.hour', DEFAULT_CRON_HOUR);
    const minute = this.configService.get<number>(
      'cron.minute',
      DEFAULT_CRON_MINUTE,
    );

    return {
      enabled: this.configService.get<boolean>('cron.enabled', false),
      jobName:
        this.configService.get<string>('cron.jobName') ?? DEFAULT_CRON_JOB_NAME,
      expression:
        this.configService.get<string>('cron.expression') ??
        `${minute} ${hour} * * *`,
      timezone:
        this.configService.get<string>('cron.timezone') ??
        DEFAULT_CRON_TIMEZONE,
      batchLimit:
        this.configService.get<number>(
          'cron.batchLimit',
          DEFAULT_CRON_BATCH_LIMIT,
        ) ?? DEFAULT_CRON_BATCH_LIMIT,
    };
  }
}
