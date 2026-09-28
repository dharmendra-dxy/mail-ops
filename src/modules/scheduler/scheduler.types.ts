import type { DailyCycleResult, SkipReason } from '../campaign';

export interface SchedulerStatus {
  /** `CRON_ENABLED`. False means no job object exists at all. */
  enabled: boolean;
  /** True only while a `CronJob` is registered in the `SchedulerRegistry`. */
  registered: boolean;
  jobName: string | null;
  /** `min hour * * *`, or null when cron is disabled. */
  expression: string | null;
  timezone: string | null;
  /** Configured per-run cap. */
  batchLimit: number;
  /** ISO timestamp of the most recent cycle, whatever triggered it. */
  lastRunAt: string | null;
  lastRun: DailyCycleResult | null;
  /** ISO timestamp of the most recent failed cycle, if any. */
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface SchedulerRunResponse {
  trigger: 'CRON' | 'MANUAL';
  /** The cycle result. Null when the cycle did not run, or blew up. */
  result: DailyCycleResult | null;
  /** Set when the cycle was refused because a run already held the lock. */
  skipped: SkipReason;
  /** One-line reason when the cycle itself failed. */
  error: string | null;
}

export type { DailyCycleResult };
