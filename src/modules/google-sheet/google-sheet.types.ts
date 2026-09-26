import {
  BOOLEAN_FLAGS,
  CANDIDATE_ROLES,
  CANDIDATE_STATUSES,
  FOLLOW_UP_STATUSES,
  SHEET_DRIVER_OPTIONS,
} from './google-sheet.constant';

export type CandidateRole = (typeof CANDIDATE_ROLES)[number];
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];
export type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

/** A single sheet connection the app operates on. */
export interface SheetConnection {
  spreadsheetId: string;
  sheetName: string;
  driver: string;
}

/** Values accepted for a targeted cell update. */
export type SheetCellValue = string | number | boolean | null;

/**
 * Patch keyed by canonical column name. Only the supplied columns are written,
 * which is what keeps `updateRow` from clobbering the rest of the row.
 */
export type CandidateRowPatch = Partial<Record<string, SheetCellValue>>;

export interface SheetWriteOperation {
  rowNumber: number;
  startColumnIndex: number;
  values: SheetCellValue[];
}

export interface SheetDriverContext {
  spreadsheetId: string;
  sheetName: string;
}

/**
 * Transport used to reach the Google Sheet. Implementations differ in how they
 * authenticate (Apps Script web app, service account, ...) but not in shape.
 */
export interface SheetDriver {
  readonly name: string;
  /** Resolves the tab names of a spreadsheet. Throws if it cannot reach it. */
  listSheetNames(spreadsheetId: string): Promise<string[]>;
  readRange(context: SheetDriverContext, a1Range?: string): Promise<string[][]>;
  /** Returns the number of cells written. */
  writeRange(
    context: SheetDriverContext,
    a1Range: string,
    values: SheetCellValue[][],
  ): Promise<number>;
}

export type SheetDriverName =
  (typeof SHEET_DRIVER_OPTIONS)[keyof typeof SHEET_DRIVER_OPTIONS];

/** Row-level validation failure, keyed back to the sheet row it came from. */
export interface CandidateRowError {
  row: number;
  field: string;
  message: string;
}
