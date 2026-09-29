import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Candidate } from './entities/candidate.entity';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_CANDIDATE_STATUS,
  DEFAULT_FOLLOW_UP_DAYS,
  DEFAULT_FOLLOW_UP_ENABLED,
  DEFAULT_FOLLOW_UP_STATUS,
  FIRST_DATA_ROW_NUMBER,
  HEADER_ROW_NUMBER,
  REQUIRED_SHEET_COLUMNS,
  SHEET_COLUMNS,
  SHEET_COLUMN_ORDER,
} from './google-sheet.constant';
import { GoogleSheetRepository } from './google-sheet.repository';
import {
  CandidateRowPatch,
  SheetCellValue,
  SheetConnection,
} from './google-sheet.types';
import {
  buildRowRange,
  extractSpreadsheetId,
  groupContiguousColumns,
  normalizeHeader,
} from './google-sheet.utils';

export interface ConnectSheetInput {
  spreadsheetUrl: string;
  sheetName?: string;
}

export interface SheetConnectionResult extends SheetConnection {
  sheetNames: string[];
  active: boolean;
}

/** What the health check needs to prove the sheet is reachable. */
export interface SheetConnectivityResult extends SheetConnection {
  sheetNames: string[];
}

@Injectable()
export class GoogleSheetService {
  private readonly logger = new Logger(GoogleSheetService.name);

  /**
   * Runtime connection set through `POST /campaign/connect-sheet`. There is no
   * database in V1, so it lives for the lifetime of the process and any restart
   * falls back to the environment configuration.
   */
  private connectionOverride?: SheetConnection;

  /** Header row -> column index, cached per tab so writes need no extra read. */
  private readonly headerCache = new Map<string, Map<string, number>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly repository: GoogleSheetRepository,
  ) {}

  getConnection(): SheetConnection {
    if (this.connectionOverride) return this.connectionOverride;

    return {
      spreadsheetId: this.configService.get<string>(
        'googleSheet.defaultSpreadsheetId',
        '',
      ),
      sheetName: this.configService.get<string>(
        'googleSheet.defaultSheetName',
        '',
      ),
      driver: this.repository.driverName,
    };
  }

  /**
   * Registers the spreadsheet to operate on and verifies it is actually
   * reachable with the configured driver.
   */
  async connect(input: ConnectSheetInput): Promise<SheetConnectionResult> {
    const spreadsheetId = extractSpreadsheetId(input.spreadsheetUrl);
    if (!spreadsheetId) {
      throw new BadRequestException(
        'spreadsheetUrl must be a Google Sheets URL or a bare spreadsheet id',
      );
    }

    const sheetName = input.sheetName?.trim() || this.getConnection().sheetName;
    if (!sheetName) {
      throw new BadRequestException(
        'sheetName is required because SHEET_NAME is not configured',
      );
    }

    const connection: SheetConnection = {
      spreadsheetId,
      sheetName,
      driver: this.repository.driverName,
    };

    const sheetNames = await this.repository.listSheetNames(connection);
    if (!sheetNames.length) {
      throw new NotFoundException(
        `Spreadsheet ${spreadsheetId} is not reachable with the ${connection.driver} driver. ` +
          'For the Apps Script driver, share the sheet with the account running the script.',
      );
    }

    if (!sheetNames.includes(sheetName)) {
      throw new NotFoundException(
        `Tab "${sheetName}" not found. Available tabs: ${sheetNames.join(', ')}`,
      );
    }

    this.connectionOverride = connection;
    this.headerCache.delete(sheetName);
    this.logger.log(
      `Connected to spreadsheet ${spreadsheetId}, tab "${sheetName}" via ${connection.driver}`,
    );

    return { ...connection, sheetNames, active: true };
  }

  /**
   * Cheapest possible reachability probe: lists the tabs without reading a
   * single data row. Used by the health check, where reading 60 rows to answer
   * "is the sheet reachable" would cost an extra quota unit for nothing.
   */
  async checkConnectivity(
    connection = this.getConnection(),
  ): Promise<SheetConnectivityResult> {
    const sheetNames = await this.repository.listSheetNames(connection);

    return { ...connection, sheetNames };
  }

  /** Reads every data row and maps it to a typed `Candidate`. */
  async getCandidates(connection = this.getConnection()): Promise<Candidate[]> {
    this.assertConfigured(connection);

    const rows = await this.repository.readRows(connection);
    const columnIndex = this.loadColumnIndex(connection.sheetName, rows[0]);

    const candidates: Candidate[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (index === 0 || !row || row.every((cell) => !cell || !cell.trim()))
        continue;

      candidates.push(
        this.mapRowToCandidate(
          FIRST_DATA_ROW_NUMBER + index - 1,
          columnIndex,
          row,
        ),
      );
    }

    return candidates;
  }

  /**
   * Writes a targeted patch to a single row. Contiguous columns are grouped so
   * untouched cells in the row are never overwritten.
   */
  async updateRow(
    rowNumber: number,
    patch: CandidateRowPatch,
    connection = this.getConnection(),
  ): Promise<number> {
    this.assertConfigured(connection);

    const entries = Object.entries(patch).filter(
      (entry): entry is [string, SheetCellValue] => entry[1] !== undefined,
    );

    if (entries.length === 0) return 0;

    const columnIndex = await this.resolveColumnIndex(connection);

    // An unknown column name is a programming error, not something to ignore
    // silently: it would mean send state is written nowhere.
    const indexes = entries.map(([column]) => {
      const index = columnIndex.get(column);
      if (!SHEET_COLUMN_ORDER.includes(column) || index === undefined) {
        throw new BadRequestException(
          `Column "${column}" does not exist in tab "${connection.sheetName}"`,
        );
      }
      return index;
    });

    let updatedCells = 0;

    for (const segment of groupContiguousColumns(indexes)) {
      const values = entries
        .filter(
          (_entry, position) =>
            indexes[position] >= segment.start &&
            indexes[position] <= segment.end,
        )
        .map(([, value]) => normalizeCellValue(value));

      const range = buildRowRange(
        connection.sheetName,
        rowNumber,
        segment.start,
        segment.end,
      );

      updatedCells += await this.repository.writeValues(connection, range, [
        values,
      ]);
    }

    return updatedCells;
  }

  private mapRowToCandidate(
    rowNumber: number,
    columnIndex: Map<string, number>,
    row: string[],
  ): Candidate {
    const read = (column: string): string =>
      (row[(columnIndex.get(column) ?? 0) - 1] ?? '').toString().trim();
    const readOptional = (column: string): string | null =>
      read(column) || null;
    const readNumber = (column: string, fallback: number): number => {
      const value = read(column);
      if (value === '') return fallback;

      const parsed = Number(value);
      // A non-numeric cell is kept as NaN so validation can report the cell
      // instead of the row being silently rewritten with a default.
      return Number.isNaN(parsed) ? Number.NaN : parsed;
    };

    const candidate = new Candidate();
    candidate.rowNumber = rowNumber;
    candidate.name = read(SHEET_COLUMNS.NAME);
    candidate.email = read(SHEET_COLUMNS.EMAIL);
    candidate.company = read(SHEET_COLUMNS.COMPANY);
    candidate.role = read(SHEET_COLUMNS.ROLE).toUpperCase();
    candidate.status =
      read(SHEET_COLUMNS.STATUS).toUpperCase() || DEFAULT_CANDIDATE_STATUS;
    candidate.sentAt = readOptional(SHEET_COLUMNS.SENT_AT);
    candidate.messageId = readOptional(SHEET_COLUMNS.MESSAGE_ID);
    candidate.error = readOptional(SHEET_COLUMNS.ERROR);
    candidate.attempts = readNumber(SHEET_COLUMNS.ATTEMPTS, DEFAULT_ATTEMPTS);
    candidate.campaignId = readOptional(SHEET_COLUMNS.CAMPAIGN_ID);
    candidate.followUpEnabled =
      read(SHEET_COLUMNS.FOLLOW_UP_ENABLED).toUpperCase() ||
      DEFAULT_FOLLOW_UP_ENABLED;
    candidate.followUpDays = readNumber(
      SHEET_COLUMNS.FOLLOW_UP_DAYS,
      DEFAULT_FOLLOW_UP_DAYS,
    );
    candidate.followUpStatus =
      read(SHEET_COLUMNS.FOLLOW_UP_STATUS).toUpperCase() ||
      DEFAULT_FOLLOW_UP_STATUS;
    candidate.followUpSentAt = readOptional(SHEET_COLUMNS.FOLLOW_UP_SENT_AT);
    candidate.followUpMessageId = readOptional(
      SHEET_COLUMNS.FOLLOW_UP_MESSAGE_ID,
    );
    candidate.processingStartedAt = readOptional(
      SHEET_COLUMNS.PROCESSING_STARTED_AT,
    );

    return candidate;
  }

  private loadColumnIndex(
    sheetName: string,
    headerRow: string[] | undefined,
  ): Map<string, number> {
    if (!headerRow) {
      throw new BadRequestException(
        `Tab "${sheetName}" is empty — no header row found`,
      );
    }

    const columnIndex = new Map<string, number>();

    headerRow.forEach((header, position) => {
      const normalized = normalizeHeader(header ?? '');
      if (normalized && !columnIndex.has(normalized)) {
        columnIndex.set(normalized, position + 1);
      }
    });

    const missing = REQUIRED_SHEET_COLUMNS.filter(
      (column) => !columnIndex.has(column),
    );

    if (missing.length > 0) {
      throw new BadRequestException(
        `Tab "${sheetName}" is missing required column(s): ${missing.join(', ')}. ` +
          `Header is row ${HEADER_ROW_NUMBER}, first data row is ${FIRST_DATA_ROW_NUMBER}.`,
      );
    }

    this.headerCache.set(sheetName, columnIndex);
    return columnIndex;
  }

  private getColumnIndex(sheetName: string): Map<string, number> | undefined {
    return this.headerCache.get(sheetName);
  }

  /**
   * Column indexes are cached on read. A write issued before any read fetches
   * just the header row rather than the whole tab.
   */
  private async resolveColumnIndex(
    connection: SheetConnection,
  ): Promise<Map<string, number>> {
    const cached = this.getColumnIndex(connection.sheetName);
    if (cached) return cached;

    const headerRange = buildRowRange(
      connection.sheetName,
      HEADER_ROW_NUMBER,
      1,
      SHEET_COLUMN_ORDER.length,
    );
    const [headerRow] = await this.repository.readRows(connection, headerRange);

    return this.loadColumnIndex(connection.sheetName, headerRow);
  }

  private assertConfigured(connection: SheetConnection): void {
    if (!connection.spreadsheetId || !connection.sheetName) {
      throw new BadRequestException(
        'No spreadsheet connected. Set GOOGLE_SPREADSHEET_ID and SHEET_NAME, or call POST /campaign/connect-sheet first.',
      );
    }
  }
}

function normalizeCellValue(value: SheetCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (typeof value === 'number' && Number.isNaN(value)) return '';

  return String(value);
}
