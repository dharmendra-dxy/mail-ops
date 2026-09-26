import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetRepository } from './google-sheet.repository';
import { GoogleSheetService } from './google-sheet.service';
import { SHEET_COLUMNS } from './google-sheet.constant';

const SPREADSHEET_ID = '1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I';

const HEADER_ROW = [
  'name',
  'email',
  'company',
  'role',
  'status',
  'sent_at',
  'message_id',
  'error',
  'attempts',
  'campaign_id',
  'follow_up_enabled',
  'follow_up_days',
  'follow_up_status',
  'follow_up_sent_at',
  'follow_up_message_id',
  'processing_started_at',
];

const configValues: Record<string, unknown> = {
  'googleSheet.defaultSpreadsheetId': SPREADSHEET_ID,
  'googleSheet.defaultSheetName': 'Candidates',
};

describe('GoogleSheetService', () => {
  let repository: jest.Mocked<
    Pick<
      GoogleSheetRepository,
      'driverName' | 'listSheetNames' | 'readRows' | 'writeValues'
    >
  >;
  let service: GoogleSheetService;

  beforeEach(() => {
    repository = {
      driverName: 'apps_script',
      listSheetNames: jest.fn().mockResolvedValue(['Candidates', 'Archive']),
      readRows: jest.fn().mockResolvedValue([]),
      writeValues: jest.fn().mockResolvedValue(1),
    };

    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in configValues ? configValues[key] : fallback,
      ),
    } as unknown as ConfigService;

    service = new GoogleSheetService(
      configService,
      repository as unknown as GoogleSheetRepository,
    );
  });

  describe('getCandidates', () => {
    it('maps rows to candidates and skips blank rows', async () => {
      repository.readRows.mockResolvedValue([
        HEADER_ROW,
        [
          'Asha',
          'asha@example.com',
          'Acme',
          'frontend',
          '',
          '',
          '',
          '',
          '',
          '',
          'yes',
          '3',
          '',
          '',
          '',
          '',
        ],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        [
          'Bad Row',
          'not-an-email',
          'Globex',
          'DESIGNER',
          'pending',
          '',
          '',
          '',
          'many',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
      ]);

      const candidates = await service.getCandidates();

      expect(candidates).toHaveLength(2);

      const [first, second] = candidates;
      expect(first.rowNumber).toBe(2);
      expect(first.role).toBe('FRONTEND');
      expect(first.status).toBe('PENDING');
      expect(first.followUpEnabled).toBe('YES');
      expect(first.followUpDays).toBe(3);
      expect(first.attempts).toBe(0);

      expect(second.rowNumber).toBe(4);
      expect(second.role).toBe('DESIGNER');
      expect(second.status).toBe('PENDING');
      expect(second.attempts).toBeNaN();
    });

    it('rejects a tab that is missing required columns', async () => {
      repository.readRows.mockResolvedValue([
        ['name', 'email', 'company'],
        ['Asha', 'asha@example.com', 'Acme'],
      ]);

      await expect(service.getCandidates()).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('fails when no spreadsheet is connected', async () => {
      configValues['googleSheet.defaultSpreadsheetId'] = '';
      configValues['googleSheet.defaultSheetName'] = '';

      await expect(service.getCandidates()).rejects.toBeInstanceOf(
        BadRequestException,
      );

      configValues['googleSheet.defaultSpreadsheetId'] = SPREADSHEET_ID;
      configValues['googleSheet.defaultSheetName'] = 'Candidates';
    });
  });

  describe('updateRow', () => {
    beforeEach(() => {
      repository.readRows.mockResolvedValue([HEADER_ROW]);
    });

    it('writes only the patched columns, grouped by contiguity', async () => {
      repository.readRows.mockResolvedValue([
        HEADER_ROW,
        [
          'Asha',
          'asha@example.com',
          'Acme',
          'FRONTEND',
          'PENDING',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
      ]);
      await service.getCandidates();

      const updated = await service.updateRow(2, {
        [SHEET_COLUMNS.STATUS]: 'PROCESSING',
        [SHEET_COLUMNS.PROCESSING_STARTED_AT]: '2026-09-27T10:00:00.000Z',
        [SHEET_COLUMNS.ATTEMPTS]: 1,
      });

      expect(repository.writeValues).toHaveBeenCalledTimes(3);
      expect(repository.writeValues).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ sheetName: 'Candidates' }),
        "'Candidates'!E2:E2",
        [['PROCESSING']],
      );
      expect(repository.writeValues).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sheetName: 'Candidates' }),
        "'Candidates'!I2:I2",
        [['1']],
      );
      expect(repository.writeValues).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ sheetName: 'Candidates' }),
        "'Candidates'!P2:P2",
        [['2026-09-27T10:00:00.000Z']],
      );
      expect(updated).toBe(3);
    });

    it('merges contiguous columns into a single write', async () => {
      await service.getCandidates();

      await service.updateRow(2, {
        [SHEET_COLUMNS.STATUS]: 'SENT',
        [SHEET_COLUMNS.SENT_AT]: '2026-09-27T10:00:00.000Z',
      });

      expect(repository.writeValues).toHaveBeenCalledTimes(1);
      expect(repository.writeValues).toHaveBeenCalledWith(
        expect.anything(),
        "'Candidates'!E2:F2",
        [['SENT', '2026-09-27T10:00:00.000Z']],
      );
    });

    it('does nothing for an empty patch', async () => {
      await expect(service.updateRow(2, {})).resolves.toBe(0);
      expect(repository.readRows).not.toHaveBeenCalled();
      expect(repository.writeValues).not.toHaveBeenCalled();
    });

    it('reads only the header row when no read has happened yet', async () => {
      repository.readRows.mockResolvedValue([HEADER_ROW]);

      await service.updateRow(2, { [SHEET_COLUMNS.STATUS]: 'SENT' });

      expect(repository.readRows).toHaveBeenCalledWith(
        expect.anything(),
        "'Candidates'!A1:P1",
      );
      expect(repository.writeValues).toHaveBeenCalledWith(
        expect.anything(),
        "'Candidates'!E2:E2",
        [['SENT']],
      );
    });

    it('rejects a column that is not in the sheet', async () => {
      await service.getCandidates();

      await expect(
        service.updateRow(2, { unknown_column: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('connect', () => {
    it('rejects a value that is not a spreadsheet reference', async () => {
      await expect(
        service.connect({ spreadsheetUrl: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown tab', async () => {
      await expect(
        service.connect({
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
          sheetName: 'Missing',
        }),
      ).rejects.toThrow(/not found/);
    });

    it('registers the connection for subsequent reads', async () => {
      const connection = await service.connect({
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      });

      expect(connection).toMatchObject({
        spreadsheetId: SPREADSHEET_ID,
        sheetName: 'Candidates',
        active: true,
      });
      expect(service.getConnection().spreadsheetId).toBe(SPREADSHEET_ID);
    });
  });
});
