import { registerAs } from '@nestjs/config';
import {
  DEFAULT_CRON_BATCH_LIMIT,
  DEFAULT_CRON_HOUR,
  DEFAULT_CRON_JOB_NAME,
  DEFAULT_CRON_MINUTE,
  DEFAULT_CRON_TIMEZONE,
  MAX_CRON_HOUR,
  MAX_CRON_MINUTE,
} from '../modules/scheduler/scheduler.constant';

const TRUTHY = ['true', '1', 'yes'];
const FALSY = ['false', '0', 'no'];

/**
 * A cron schedule that never fires is indistinguishable from a broken one, so
 * the values are validated hard at boot instead of being silently coerced.
 */
function parseCronField(
  name: string,
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const value = raw?.trim() || String(fallback);
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(
      `${name} must be an integer between 0 and ${max}, received "${raw ?? ''}"`,
    );
  }

  return parsed;
}

function parseBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;

  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.includes(normalized)) return true;
  if (FALSY.includes(normalized)) return false;

  throw new Error(
    `${name} must be one of: ${[...TRUTHY, ...FALSY].join(', ')}, received "${raw}"`,
  );
}

/** Guards against a typo that would otherwise only surface as "never ran". */
function assertValidTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(
      `CRON_TIMEZONE "${timezone}" is not a valid IANA time zone (e.g. Asia/Kolkata)`,
    );
  }

  return timezone;
}

export default registerAs('cron', () => {
  const hour = parseCronField(
    'CRON_HOUR',
    process.env.CRON_HOUR,
    DEFAULT_CRON_HOUR,
    MAX_CRON_HOUR,
  );
  const minute = parseCronField(
    'CRON_MINUTE',
    process.env.CRON_MINUTE,
    DEFAULT_CRON_MINUTE,
    MAX_CRON_MINUTE,
  );

  return {
    enabled: parseBoolean('CRON_ENABLED', process.env.CRON_ENABLED, false),
    hour,
    minute,
    timezone: assertValidTimezone(
      process.env.CRON_TIMEZONE?.trim() || DEFAULT_CRON_TIMEZONE,
    ),
    /**
     * `min hour * * *`. Cron's day-of-month/day-of-week are `*` because the
     * only policy in V1 is "every day at this local time".
     */
    expression: `${minute} ${hour} * * *`,
    jobName: process.env.CRON_JOB_NAME?.trim() || DEFAULT_CRON_JOB_NAME,
    /** Upper bound per run, so a sheet that grew unexpectedly cannot burst. */
    batchLimit: Number.parseInt(
      process.env.CRON_BATCH_LIMIT ?? String(DEFAULT_CRON_BATCH_LIMIT),
      10,
    ),
  };
});
