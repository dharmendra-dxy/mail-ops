import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SHEET_DRIVER } from './google-sheet.constant';
import type {
  SheetCellValue,
  SheetConnection,
  SheetDriver,
} from './google-sheet.types';

/**
 * Data-access layer for the sheet. It only speaks the driver's transport
 * contract — interpreting rows into candidates is the service's job.
 */
@Injectable()
export class GoogleSheetRepository {
  constructor(
    @Inject(SHEET_DRIVER) private readonly driver: SheetDriver,
    private readonly configService: ConfigService,
  ) {}

  get driverName(): string {
    return this.driver.name;
  }

  async listSheetNames(connection: SheetConnection): Promise<string[]> {
    return this.driver.listSheetNames(connection.spreadsheetId);
  }

  async readRows(
    connection: SheetConnection,
    a1Range?: string,
  ): Promise<string[][]> {
    return this.driver.readRange(
      {
        spreadsheetId: connection.spreadsheetId,
        sheetName: connection.sheetName,
      },
      a1Range,
    );
  }

  async writeValues(
    connection: SheetConnection,
    a1Range: string,
    values: SheetCellValue[][],
  ): Promise<number> {
    return this.driver.writeRange(
      {
        spreadsheetId: connection.spreadsheetId,
        sheetName: connection.sheetName,
      },
      a1Range,
      values,
    );
  }

  get requestTimeoutMs(): number {
    return this.configService.get<number>(
      'googleSheet.requestTimeoutMs',
      15000,
    );
  }
}
