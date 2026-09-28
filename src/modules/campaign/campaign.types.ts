import { CandidateRowError, SheetConnection } from '../google-sheet';
import type { TemplateType } from '../template';
import { CAMPAIGN_RUN_STATUS } from './campaign.constant';

export interface SheetValidationReport {
  connection: SheetConnection;
  total: number;
  valid: number;
  invalid: number;
  errors: CandidateRowError[];
}

export interface ConnectSheetResponse extends SheetConnection {
  sheetNames: string[];
  active: boolean;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  failed: number;
}

export interface CandidatePreview {
  row: number;
  name: string;
  email: string;
  company: string;
  role: string;
  type: string;
  subject: string;
  body: string;
}

export interface CampaignPreviewResponse {
  connection: SheetConnection;
  counts: CampaignCounts;
  eligible: number;
  type: string;
  previews: CandidatePreview[];
}

/** One row's outcome, whether it was only rendered or actually sent. */
export interface SendResultRow {
  row: number;
  email: string;
  name: string;
  company: string;
  role: string;
  subject: string;
  status: 'DRY_RUN' | 'SENT' | 'FAILED';
  messageId?: string;
  error?: string;
}

/**
 * Dry runs finish inline — rendering is fast and the caller needs the rendered
 * emails back — so the full result set is returned in the response.
 */
export interface CampaignSendResponse {
  connection: SheetConnection;
  status: typeof CAMPAIGN_RUN_STATUS.DRY_RUN_COMPLETED;
  campaignId: string;
  dryRun: true;
  eligible: number;
  processed: number;
  sent: number;
  failed: number;
  results: SendResultRow[];
}

/**
 * A real send is handed to a background run and answers immediately, because a
 * 60-row batch takes roughly `limit * EMAIL_DELAY_MS` to finish. Progress is
 * observable through `GET /campaign/status` and the sheet itself.
 */
export interface CampaignStartResponse {
  connection: SheetConnection;
  status: typeof CAMPAIGN_RUN_STATUS.STARTED;
  campaignId: string;
  dryRun: false;
  total: number;
}

export type CampaignRunResponse = CampaignSendResponse | CampaignStartResponse;

/**
 * Why a batch did not run. The single-run lock is the only reason in V1: a
 * manual send and the daily cron must never overlap on one instance.
 */
export const SKIP_REASON = {
  RUN_IN_PROGRESS: 'RUN_IN_PROGRESS',
} as const;

export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON] | null;

/** Outcome of one batch (initial emails or follow-ups) inside a run. */
export interface BatchRunResult {
  campaignId: string | null;
  /** Rows that matched the eligibility filter, before the batch cap. */
  eligible: number;
  processed: number;
  sent: number;
  failed: number;
  skipped: SkipReason;
  /** Follow-up batches only: rows promoted `NOT_SCHEDULED` → `SCHEDULED`. */
  promoted: number;
}

export interface DailyCycleResult {
  startedAt: string;
  finishedAt: string;
  skipped: SkipReason;
  initial: BatchRunResult;
  followUp: BatchRunResult;
  /** Rows moved from `NOT_SCHEDULED` to `SCHEDULED` during this cycle. */
  promoted: number;
}

export interface ScheduledRunOptions {
  /** Upper bound on rows per batch. Omit for "everything eligible". */
  limit?: number;
  /** Restricts initial emails to one role. Follow-ups ignore this. */
  role?: string;
  /** Template variant for initial emails. Follow-ups always render `follow_up`. */
  type?: TemplateType;
}

export interface FollowUpCounts {
  notScheduled: number;
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  enabled: number;
}

export interface CampaignStatusResponse {
  connection: SheetConnection;
  counts: CampaignCounts;
  followUp: FollowUpCounts;
  /** True while a background run holds the single-run lock. */
  running: boolean;
  activeCampaignId: string | null;
}
