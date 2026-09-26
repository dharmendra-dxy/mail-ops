import { Test, TestingModule } from '@nestjs/testing';
import { Candidate, GoogleSheetService } from '../google-sheet';
import { CampaignService } from './campaign.service';

const CONNECTION = {
  spreadsheetId: '1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I',
  sheetName: 'Candidates',
  driver: 'apps_script',
};

function buildCandidate(overrides: Partial<Candidate>): Candidate {
  const candidate = new Candidate();
  Object.assign(
    candidate,
    {
      rowNumber: 2,
      name: 'Asha',
      email: 'asha@example.com',
      company: 'Acme',
      role: 'FRONTEND',
      status: 'PENDING',
      sentAt: null,
      messageId: null,
      error: null,
      attempts: 0,
      campaignId: null,
      followUpEnabled: 'NO',
      followUpDays: 0,
      followUpStatus: 'NOT_SCHEDULED',
      followUpSentAt: null,
      followUpMessageId: null,
      processingStartedAt: null,
    },
    overrides,
  );

  return candidate;
}

describe('CampaignService', () => {
  let service: CampaignService;
  let googleSheetService: {
    getConnection: jest.Mock;
    getCandidates: jest.Mock;
    connect: jest.Mock;
  };

  beforeEach(async () => {
    googleSheetService = {
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([]),
      connect: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignService,
        { provide: GoogleSheetService, useValue: googleSheetService },
      ],
    }).compile();

    service = module.get(CampaignService);
  });

  describe('validateSheet', () => {
    it('reports counts and no errors for a clean sheet', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({
          rowNumber: 3,
          email: 'hr@globex.com',
          role: 'BACKEND',
        }),
      ]);

      await expect(service.validateSheet()).resolves.toEqual({
        connection: CONNECTION,
        total: 2,
        valid: 2,
        invalid: 0,
        errors: [],
      });
    });

    it('reports row-level errors for invalid cells', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({ rowNumber: 3, email: 'not-an-email' }),
        buildCandidate({ rowNumber: 4, role: 'DESIGNER' }),
        buildCandidate({ rowNumber: 5, name: '', company: '' }),
        buildCandidate({
          rowNumber: 6,
          followUpEnabled: 'TRUE',
          followUpDays: -1,
        }),
      ]);

      const report = await service.validateSheet();

      expect(report.total).toBe(5);
      expect(report.valid).toBe(1);
      expect(report.invalid).toBe(4);
      expect(report.errors).toEqual(
        expect.arrayContaining([
          {
            row: 3,
            field: 'email',
            message: 'email is not a valid email address',
          },
          {
            row: 4,
            field: 'role',
            message: 'role must be one of: FRONTEND, BACKEND, FULL_STACK',
          },
          { row: 5, field: 'name', message: 'name is required' },
          { row: 5, field: 'company', message: 'company is required' },
        ]),
      );
      expect(report.errors.every((error) => error.row !== 2)).toBe(true);
    });

    it('flags a non-numeric attempts cell instead of rewriting it', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2, attempts: Number.NaN }),
      ]);

      const report = await service.validateSheet();

      expect(report.invalid).toBe(1);
      expect(report.errors[0].field).toBe('attempts');
    });
  });

  it('delegates connect to the sheet service', async () => {
    googleSheetService.connect.mockResolvedValue({
      ...CONNECTION,
      active: true,
    });

    await expect(
      service.connectSheet(
        `https://docs.google.com/spreadsheets/d/${CONNECTION.spreadsheetId}/edit`,
      ),
    ).resolves.toMatchObject({ active: true });

    expect(googleSheetService.connect).toHaveBeenCalledWith({
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${CONNECTION.spreadsheetId}/edit`,
      sheetName: undefined,
    });
  });
});
