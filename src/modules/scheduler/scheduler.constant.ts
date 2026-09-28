/**
 * Scheduling defaults. Environment overrides live in `config/cron.config.ts`,
 * which validates them at boot — these are only the fallbacks.
 */
export const DEFAULT_CRON_HOUR = 8;
export const DEFAULT_CRON_MINUTE = 0;
export const DEFAULT_CRON_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_CRON_BATCH_LIMIT = 50;

/** Registry key for the single daily job. */
export const DEFAULT_CRON_JOB_NAME = 'mailops-daily-campaign';

export const MAX_CRON_HOUR = 23;
export const MAX_CRON_MINUTE = 59;

/** The single daily cycle: due initial emails first, then due follow-ups. */
export const CRON_RUN_KIND = 'daily-campaign';
