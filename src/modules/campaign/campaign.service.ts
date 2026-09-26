import { Injectable } from '@nestjs/common';
import { validate, ValidationError } from 'class-validator';
import { Candidate, GoogleSheetService } from '../google-sheet';
import { ConnectSheetResponse, SheetValidationReport } from './campaign.types';

const VALIDATION_OPTIONS = {
  whitelist: false,
  forbidUnknownValues: false,
  validationError: { target: false, value: false },
};

@Injectable()
export class CampaignService {
  constructor(private readonly googleSheetService: GoogleSheetService) {}

  async connectSheet(
    spreadsheetUrl: string,
    sheetName?: string,
  ): Promise<ConnectSheetResponse> {
    return this.googleSheetService.connect({ spreadsheetUrl, sheetName });
  }

  /**
   * Reports which sheet rows can be used for a send. Validation rules live on
   * the `Candidate` entity, so this only maps class-validator output onto the
   * row/field shape the API contract promises.
   */
  async validateSheet(): Promise<SheetValidationReport> {
    const connection = this.googleSheetService.getConnection();
    const candidates = await this.googleSheetService.getCandidates(connection);

    const errors: SheetValidationReport['errors'] = [];
    let valid = 0;

    for (const candidate of candidates) {
      const rowErrors = await validateCandidate(candidate);

      if (rowErrors.length === 0) {
        valid += 1;
        continue;
      }

      errors.push(...rowErrors);
    }

    return {
      connection,
      total: candidates.length,
      valid,
      invalid: candidates.length - valid,
      errors,
    };
  }
}

async function validateCandidate(
  candidate: Candidate,
): Promise<SheetValidationReport['errors']> {
  const validationErrors = await validate(candidate, VALIDATION_OPTIONS);
  const { rowNumber } = candidate;

  return validationErrors.flatMap((error) =>
    flattenValidationError(rowNumber, error),
  );
}

function flattenValidationError(
  rowNumber: number,
  error: ValidationError,
): SheetValidationReport['errors'] {
  const own: SheetValidationReport['errors'] = Object.values(
    error.constraints ?? {},
  ).map((message) => ({ row: rowNumber, field: error.property, message }));

  const nested = (error.children ?? []).flatMap((child) =>
    flattenValidationError(rowNumber, child),
  );

  return [...own, ...nested];
}
