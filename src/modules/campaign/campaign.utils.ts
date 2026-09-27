import { Candidate } from '../google-sheet';
import {
  CAMPAIGN_ID_PREFIX,
  CAMPAIGN_ID_SEPARATOR,
  CAMPAIGN_SEQUENCE_DIGITS,
  DRY_RUN_CAMPAIGN_SUFFIX,
  ERROR_CLASSIFICATION,
  ErrorClassification,
  MILLISECONDS_PER_MINUTE,
  NON_RETRYABLE_ERROR_PATTERNS,
  RETRYABLE_ERROR_PATTERNS,
} from './campaign.constant';

/** Provider errors are multi-line; the sheet cell only needs one line. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Decides whether a failed send is worth trying again. Anything unrecognised is
 * treated as non-retryable: an unknown failure may still have delivered the
 * mail, and a second attempt would duplicate it.
 */
export function classifyEmailError(error: unknown): ErrorClassification {
  const message = describeError(error);

  if (NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return ERROR_CLASSIFICATION.NON_RETRYABLE;
  }

  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return ERROR_CLASSIFICATION.RETRYABLE;
  }

  return ERROR_CLASSIFICATION.NON_RETRYABLE;
}

/** `campaign-20260927` — the date-scoped prefix of a real campaign id. */
export function formatCampaignId(date: Date): string {
  return `${CAMPAIGN_ID_PREFIX}${date.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

export function formatDryRunCampaignId(date: Date): string {
  return `${formatCampaignId(date)}-${DRY_RUN_CAMPAIGN_SUFFIX}`;
}

/**
 * Picks the next free sequence number for today by looking at the ids already
 * stamped on the sheet, so numbering survives a restart (there is no database).
 */
export function nextCampaignId(
  existingIds: readonly (string | null | undefined)[],
  date: Date,
): string {
  const prefix = formatCampaignId(date);
  let highest = 0;

  for (const id of existingIds) {
    if (!id?.startsWith(prefix)) continue;

    // The separator has to be consumed explicitly: `parseInt('-004')` is -4.
    const sequence = Number.parseInt(
      id.slice(prefix.length + CAMPAIGN_ID_SEPARATOR.length),
      10,
    );
    if (!Number.isNaN(sequence) && sequence > highest) highest = sequence;
  }

  return `${prefix}${CAMPAIGN_ID_SEPARATOR}${String(highest + 1).padStart(
    CAMPAIGN_SEQUENCE_DIGITS,
    '0',
  )}`;
}

/**
 * A PROCESSING row older than the threshold is treated as a crash leftover and
 * becomes eligible again. A PROCESSING row with no usable timestamp is also
 * considered stale: the single-run lock means nothing can be in flight.
 */
export function isStaleProcessing(
  candidate: Candidate,
  thresholdMinutes: number,
  now: number = Date.now(),
): boolean {
  const startedAt = candidate.processingStartedAt
    ? Date.parse(candidate.processingStartedAt)
    : Number.NaN;

  if (Number.isNaN(startedAt)) return true;

  return now - startedAt >= thresholdMinutes * MILLISECONDS_PER_MINUTE;
}
