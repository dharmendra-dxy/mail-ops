import { CandidateStatus } from '../google-sheet';

export const PENDING: CandidateStatus = 'PENDING';
export const PROCESSING: CandidateStatus = 'PROCESSING';
export const SENT: CandidateStatus = 'SENT';
export const FAILED: CandidateStatus = 'FAILED';

/** Campaign ids are `campaign-YYYYMMDD-NNN`; the date part is this prefix. */
export const CAMPAIGN_ID_PREFIX = 'campaign-';
export const CAMPAIGN_ID_SEPARATOR = '-';
export const CAMPAIGN_SEQUENCE_DIGITS = 3;

/**
 * Dry runs render emails without touching a single sheet cell, so they must not
 * consume a real sequence number — that number is what links rows to a run.
 */
export const DRY_RUN_CAMPAIGN_SUFFIX = 'dry';

export const CAMPAIGN_RUN_STATUS = {
  STARTED: 'STARTED',
  DRY_RUN_COMPLETED: 'DRY_RUN_COMPLETED',
} as const;

export type CampaignRunStatus =
  (typeof CAMPAIGN_RUN_STATUS)[keyof typeof CAMPAIGN_RUN_STATUS];

export const ERROR_CLASSIFICATION = {
  RETRYABLE: 'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE',
} as const;

export type ErrorClassification =
  (typeof ERROR_CLASSIFICATION)[keyof typeof ERROR_CLASSIFICATION];

/**
 * Matched against the flattened provider error message. Patterns are ordered by
 * `classifyEmailError`: a non-retryable match always wins, because retrying a
 * permanent failure only burns the attempt budget and can double-send.
 */
export const NON_RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /\b(?:401|403)\b|unauthor|forbidden|authenticat|invalid credentials|535\b|login failed|invalid_grant/i,
  /invalid email|invalid address|malformed|bad address|no such user|unknown recipient|recipient not found|mailbox (?:unavailable|not found)|\b(?:550|551|553|554)\b/i,
  /4\d\d\s+bad request|badrequest|bad request/i,
];

export const RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /econnreset|econnrefused|enotfound|eai_again|epipe|esockettimedout|etimedout/i,
  /timed?\s*out|timeout/i,
  /\b429\b|too many|rate.?limit|throttl/i,
  /\b(?:502|503|504)\b|bad gateway|service unavailable|temporarily unavailable|temporarily failed/i,
  /socket hang up|connection (?:reset|closed|aborted|error)|network error|read ?econnreset/i,
];

export const MILLISECONDS_PER_MINUTE = 60_000;

export const DEFAULT_EMAIL_DELAY_MS = 2000;
export const DEFAULT_EMAIL_MAX_RETRIES = 2;
export const DEFAULT_STALE_PROCESSING_THRESHOLD_MINUTES = 30;
