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
