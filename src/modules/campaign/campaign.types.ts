import { CandidateRowError, SheetConnection } from '../google-sheet';

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

export interface CampaignSendResponse {
  connection: SheetConnection;
  dryRun: boolean;
  eligible: number;
  processed: number;
  sent: number;
  failed: number;
  results: SendResultRow[];
}
