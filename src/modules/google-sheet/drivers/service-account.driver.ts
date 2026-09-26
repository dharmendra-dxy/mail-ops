import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, sheets_v4 } from 'googleapis';
import {
  SheetCellValue,
  SheetDriver,
  SheetDriverContext,
} from '../google-sheet.types';
import { SHEET_DRIVER_OPTIONS } from '../google-sheet.constant';

/**
 * Authenticates as a Google service account (a service identity, not a user
 * OAuth flow). The spreadsheet must be shared with the service account email as
 * an Editor. Kept as a fallback for when the Apps Script web app is not an option.
 */
@Injectable()
export class ServiceAccountSheetDriver implements SheetDriver {
  readonly name = SHEET_DRIVER_OPTIONS.SERVICE_ACCOUNT;

  private client?: sheets_v4.Sheets;

  constructor(private readonly configService: ConfigService) {}

  async listSheetNames(spreadsheetId: string): Promise<string[]> {
    const response = await this.getClient().spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });

    return (response.data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title));
  }

  async readRange(
    context: SheetDriverContext,
    a1Range?: string,
  ): Promise<string[][]> {
    const response = await this.getClient().spreadsheets.values.get({
      spreadsheetId: context.spreadsheetId,
      range: a1Range ?? this.qualifiedRange(context.sheetName),
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    return (response.data.values ?? []).map((row) => row.map(toCell));
  }

  async writeRange(
    context: SheetDriverContext,
    a1Range: string,
    values: SheetCellValue[][],
  ): Promise<number> {
    const response = await this.getClient().spreadsheets.values.update({
      spreadsheetId: context.spreadsheetId,
      range: a1Range,
      valueInputOption: 'RAW',
      requestBody: { values: values.map((row) => row.map(toCell)) },
    });

    return response.data.updatedCells ?? 0;
  }

  private qualifiedRange(sheetName: string): string {
    return `'${sheetName.replace(/'/g, "''")}'`;
  }

  private getClient(): sheets_v4.Sheets {
    if (this.client) return this.client;

    const clientEmail = this.configService.get<string>(
      'googleSheet.serviceAccount.clientEmail',
    );
    const privateKey = this.configService.get<string>(
      'googleSheet.serviceAccount.privateKey',
    );

    if (!clientEmail || !privateKey) {
      throw new ServiceUnavailableException(
        'GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not configured. ' +
          'Share the spreadsheet with the service account as an Editor, or use GOOGLE_SHEET_DRIVER=apps_script.',
      );
    }

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: this.configService.get<string[]>(
        'googleSheet.serviceAccount.scopes',
      ),
    });

    this.client = google.sheets({ version: 'v4', auth });
    return this.client;
  }
}

function toCell(value: SheetCellValue | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
