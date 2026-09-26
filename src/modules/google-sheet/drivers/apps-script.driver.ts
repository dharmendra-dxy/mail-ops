import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SheetCellValue,
  SheetDriver,
  SheetDriverContext,
} from '../google-sheet.types';
import { SHEET_DRIVER_OPTIONS } from '../google-sheet.constant';

interface AppsScriptEnvelope {
  ok: boolean;
  /** Revision of scripts/google-sheet.gs that produced this response. */
  version?: string;
  error?: string;
  warning?: string;
  resolvedSpreadsheetId?: string;
  sheetNames?: string[];
  rows?: unknown[][];
  updatedCells?: number;
}

@Injectable()
export class AppsScriptSheetDriver implements SheetDriver {
  readonly name = SHEET_DRIVER_OPTIONS.APPS_SCRIPT;

  private readonly logger = new Logger(AppsScriptSheetDriver.name);

  private reportedVersion?: string;

  constructor(private readonly configService: ConfigService) {}

  async listSheetNames(spreadsheetId: string): Promise<string[]> {
    const response = await this.call({
      action: 'meta',
      spreadsheetId,
    });

    this.reportVersion(response);

    return response.sheetNames ?? [];
  }

  async readRange(
    context: SheetDriverContext,
    a1Range?: string,
  ): Promise<string[][]> {
    const response = await this.call({
      action: 'read',
      spreadsheetId: context.spreadsheetId,
      sheetName: context.sheetName,
      // An empty range means "the whole tab" and is resolved by the script
      // via getDataRange(). A bare tab name is not valid A1 notation, so it is
      // never sent.
      range: a1Range ?? '',
    });

    this.reportVersion(response);
    this.assertSameSpreadsheet(context.spreadsheetId, response);

    return (response.rows ?? []).map((row) =>
      (row ?? []).map((cell) => toCellValue(cell)),
    );
  }

  async writeRange(
    context: SheetDriverContext,
    a1Range: string,
    values: SheetCellValue[][],
  ): Promise<number> {
    const response = await this.call({
      action: 'update',
      spreadsheetId: context.spreadsheetId,
      sheetName: context.sheetName,
      range: a1Range,
      values,
    });

    this.reportVersion(response);
    this.assertSameSpreadsheet(context.spreadsheetId, response);

    return response.updatedCells ?? 0;
  }

  /**
   * A deployment pinned to an old version silently serves an old contract, so
   * the revision actually running is logged once per process.
   */
  private reportVersion(response: AppsScriptEnvelope): void {
    if (!response.version || response.version === this.reportedVersion) return;

    this.reportedVersion = response.version;
    this.logger.log(`Apps Script bridge version ${response.version}`);
  }

  private assertSameSpreadsheet(
    requested: string,
    response: AppsScriptEnvelope,
  ): void {
    if (response.warning) this.logger.warn(response.warning);

    const resolved = response.resolvedSpreadsheetId;
    if (!requested || !resolved || requested === resolved) return;

    this.logger.warn(
      `Apps Script resolved spreadsheet ${resolved} instead of ${requested}. ` +
        'Check that the deployed web app has access to the requested spreadsheet.',
    );
  }

  private async call(
    payload: Record<string, unknown>,
  ): Promise<AppsScriptEnvelope> {
    const webAppUrl = this.configService.get<string>(
      'googleSheet.appsScriptUrl',
    );
    if (!webAppUrl) {
      throw new ServiceUnavailableException(
        'GOOGLE_APPS_SCRIPT_URL is not configured. Deploy the Apps Script web app ' +
          '(scripts/google-sheet.gs) and set GOOGLE_SHEET_DRIVER=apps_script.',
      );
    }

    const timeoutMs = this.configService.get<number>(
      'googleSheet.requestTimeoutMs',
      15000,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let raw: string;
    try {
      const response = await fetch(webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      raw = await response.text();

      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Apps Script web app responded with HTTP ${response.status}: ${raw.slice(0, 200)}`,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;

      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : (error as Error).message;

      throw new ServiceUnavailableException(
        `Could not reach the Apps Script web app (${reason}). ` +
          'Confirm the deployment is live and published for "Anyone".',
      );
    } finally {
      clearTimeout(timeout);
    }

    return this.parse(raw);
  }

  /**
   * A deployment pinned to an older revision of the script keeps serving the
   * old contract, which is the most likely cause of a range-related failure.
   */
  private describeFailure(envelope: AppsScriptEnvelope): string {
    const error = envelope.error ?? 'unknown error';

    if (!/range/i.test(error)) return error;

    return (
      `${error} — the deployed web app may be running an older version of ` +
      'scripts/google-sheet.gs. Update it: Deploy > Manage deployments > Edit > ' +
      'Version: New version.'
    );
  }

  private parse(raw: string): AppsScriptEnvelope {
    let envelope: AppsScriptEnvelope;
    try {
      envelope = JSON.parse(raw) as AppsScriptEnvelope;
    } catch {
      // A misconfigured deployment usually answers with an HTML login page.
      throw new ServiceUnavailableException(
        `Apps Script web app returned a non-JSON response: ${raw.slice(0, 200)}`,
      );
    }

    if (!envelope.ok) {
      throw new ServiceUnavailableException(
        `Apps Script web app reported an error: ${this.describeFailure(envelope)}`,
      );
    }

    return envelope;
  }
}

function toCellValue(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return JSON.stringify(cell);
  if (typeof cell === 'string') return cell;

  return JSON.stringify(cell) ?? '';
}
