export const CANDIDATE_ROLES = ['FRONTEND', 'BACKEND', 'FULL_STACK'] as const;

export const CANDIDATE_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
] as const;

export const FOLLOW_UP_STATUSES = [
  'NOT_SCHEDULED',
  'SCHEDULED',
  'PROCESSING',
  'SENT',
  'FAILED',
] as const;

export const BOOLEAN_FLAGS = ['YES', 'NO'] as const;

/**
 * Canonical sheet column order. The A1 column letters are derived from this
 * order, so reordering a constant changes where values are written back.
 */
export const SHEET_COLUMNS = {
  NAME: 'name',
  EMAIL: 'email',
  COMPANY: 'company',
  ROLE: 'role',
  STATUS: 'status',
  SENT_AT: 'sent_at',
  MESSAGE_ID: 'message_id',
  ERROR: 'error',
  ATTEMPTS: 'attempts',
  CAMPAIGN_ID: 'campaign_id',
  FOLLOW_UP_ENABLED: 'follow_up_enabled',
  FOLLOW_UP_DAYS: 'follow_up_days',
  FOLLOW_UP_STATUS: 'follow_up_status',
  FOLLOW_UP_SENT_AT: 'follow_up_sent_at',
  FOLLOW_UP_MESSAGE_ID: 'follow_up_message_id',
  PROCESSING_STARTED_AT: 'processing_started_at',
} as const;

export const SHEET_COLUMN_ORDER: string[] = Object.values(SHEET_COLUMNS);

/** Columns a sheet must declare in its header row to be usable. */
export const REQUIRED_SHEET_COLUMNS: string[] = [
  SHEET_COLUMNS.NAME,
  SHEET_COLUMNS.EMAIL,
  SHEET_COLUMNS.COMPANY,
  SHEET_COLUMNS.ROLE,
];

export const DEFAULT_CANDIDATE_STATUS = 'PENDING';
export const DEFAULT_FOLLOW_UP_ENABLED = 'NO';
export const DEFAULT_FOLLOW_UP_STATUS = 'NOT_SCHEDULED';
export const DEFAULT_ATTEMPTS = 0;
export const DEFAULT_FOLLOW_UP_DAYS = 0;

export const MAX_FOLLOW_UP_DAYS = 365;
export const HEADER_ROW_NUMBER = 1;
export const FIRST_DATA_ROW_NUMBER = 2;

export const SHEET_DRIVER = 'SHEET_DRIVER';

export const SHEET_DRIVER_OPTIONS = {
  APPS_SCRIPT: 'apps_script',
  SERVICE_ACCOUNT: 'service_account',
} as const;
