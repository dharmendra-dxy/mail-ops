import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from '../email';
import { Candidate, GoogleSheetService, SHEET_COLUMNS } from '../google-sheet';
import { TemplateService } from '../template';
import { CampaignService } from './campaign.service';
import { PreviewCandidatesDto } from './dto/preview-candidates.dto';
import { SendCampaignDto } from './dto/send-campaign.dto';

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
      name: 'Asha Rao',
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
    updateRow: jest.Mock;
  };
  let emailService: { send: jest.Mock };
  let configValues: Record<string, unknown>;

  const buildService = async (): Promise<CampaignService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignService,
        TemplateService,
        { provide: GoogleSheetService, useValue: googleSheetService },
        { provide: EmailService, useValue: emailService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key in configValues ? configValues[key] : fallback,
          },
        },
      ],
    }).compile();

    return module.get(CampaignService);
  };

  beforeEach(async () => {
    googleSheetService = {
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([]),
      connect: jest.fn(),
      updateRow: jest.fn().mockResolvedValue(1),
    };
    emailService = { send: jest.fn() };
    configValues = {
      'campaign.emailDelayMs': 0,
      'campaign.sendDefaultDryRun': true,
    };

    service = await buildService();
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

  describe('preview', () => {
    beforeEach(() => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({
          rowNumber: 3,
          name: 'Vikram Rao',
          email: 'vikram@globex.com',
          company: 'Globex',
          role: 'BACKEND',
        }),
        buildCandidate({ rowNumber: 4, status: 'SENT' }),
        buildCandidate({ rowNumber: 5, email: 'broken' }),
      ]);
    });

    it('counts by status and renders only eligible rows', async () => {
      const response = await service.preview(new PreviewCandidatesDto());

      expect(response.counts).toEqual({
        total: 4,
        pending: 3,
        processing: 0,
        sent: 1,
        failed: 0,
      });
      expect(response.eligible).toBe(2);
      expect(response.previews).toHaveLength(2);
      expect(response.previews[0]).toMatchObject({
        row: 2,
        email: 'asha@example.com',
        role: 'FRONTEND',
        type: 'initial',
      });
    });

    it('interpolates the candidate into subject and body', async () => {
      const [preview] = (await service.preview(new PreviewCandidatesDto()))
        .previews;

      expect(preview.subject).toBe('Frontend role at Acme — quick question');
      expect(preview.body).toContain('Hi Asha,');
      expect(preview.body).toContain('the Frontend opening at Acme');
      expect(preview.body).not.toContain('{{');
    });

    it('honours the limit and the role filter', async () => {
      const response = await service.preview(
        Object.assign(new PreviewCandidatesDto(), {
          limit: 1,
          role: 'BACKEND',
        }),
      );

      expect(response.previews).toHaveLength(1);
      expect(response.previews[0].role).toBe('BACKEND');
    });

    it('renders the follow_up variant on request', async () => {
      const response = await service.preview(
        Object.assign(new PreviewCandidatesDto(), {
          type: 'follow_up' as const,
        }),
      );

      expect(response.previews[0].subject).toBe('Re: Frontend role at Acme');
      expect(response.type).toBe('follow_up');
    });
  });

  describe('send', () => {
    beforeEach(() => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({
          rowNumber: 3,
          email: 'vikram@globex.com',
          role: 'BACKEND',
        }),
      ]);
    });

    it('dry-runs by default: renders, never calls the provider, never writes', async () => {
      const response = await service.send(new SendCampaignDto());

      expect(response.dryRun).toBe(true);
      expect(response.processed).toBe(2);
      expect(response.sent).toBe(0);
      expect(response.failed).toBe(0);
      expect(response.results.map((row) => row.status)).toEqual([
        'DRY_RUN',
        'DRY_RUN',
      ]);
      expect(response.results[0].subject).toBe(
        'Frontend role at Acme — quick question',
      );
      expect(emailService.send).not.toHaveBeenCalled();
      expect(googleSheetService.updateRow).not.toHaveBeenCalled();
    });

    it('respects SEND_DEFAULT_DRY_RUN when no dryRun param is given', async () => {
      configValues['campaign.sendDefaultDryRun'] = false;
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const response = await service.send(new SendCampaignDto());

      expect(response.dryRun).toBe(false);
      expect(emailService.send).toHaveBeenCalledTimes(2);
    });

    it('sends for real and writes SENT state per row', async () => {
      emailService.send
        .mockResolvedValueOnce({ messageId: 'msg-1' })
        .mockResolvedValueOnce({ messageId: 'msg-2' });

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );

      expect(response.sent).toBe(2);
      expect(response.failed).toBe(0);
      expect(emailService.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          to: 'asha@example.com',
          subject: 'Frontend role at Acme — quick question',
        }),
      );
      expect(googleSheetService.updateRow).toHaveBeenNthCalledWith(
        1,
        2,
        expect.objectContaining({
          [SHEET_COLUMNS.STATUS]: 'SENT',
          [SHEET_COLUMNS.MESSAGE_ID]: 'msg-1',
          [SHEET_COLUMNS.ATTEMPTS]: 1,
          [SHEET_COLUMNS.ERROR]: '',
        }),
      );
      const [firstRow, firstPatch] = googleSheetService.updateRow.mock
        .calls[0] as [number, Record<string, unknown>];
      expect(firstRow).toBe(2);
      expect(firstPatch[SHEET_COLUMNS.SENT_AT]).toEqual(expect.any(String));
    });

    it('records FAILED for one row and keeps sending the rest', async () => {
      emailService.send
        .mockResolvedValueOnce({ messageId: 'msg-1' })
        .mockRejectedValueOnce(new Error('550 mailbox unavailable'));

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );

      expect(response.sent).toBe(1);
      expect(response.failed).toBe(1);
      expect(response.results[1]).toMatchObject({
        row: 3,
        status: 'FAILED',
        error: '550 mailbox unavailable',
      });
      expect(googleSheetService.updateRow).toHaveBeenNthCalledWith(
        2,
        3,
        expect.objectContaining({
          [SHEET_COLUMNS.STATUS]: 'FAILED',
          [SHEET_COLUMNS.ERROR]: '550 mailbox unavailable',
          [SHEET_COLUMNS.ATTEMPTS]: 1,
        }),
      );
    });

    it('defaults to a full batch of 50 rows', () => {
      expect(new SendCampaignDto().limit).toBe(50);
      expect(new PreviewCandidatesDto().limit).toBe(5);
    });

    it('warns when the limit leaves eligible rows unprocessed', async () => {
      googleSheetService.getCandidates.mockResolvedValue(
        Array.from({ length: 3 }, (_unused, index) =>
          buildCandidate({ rowNumber: index + 2 }),
        ),
      );
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { limit: 2 }),
      );

      expect(response.eligible).toBe(3);
      expect(response.processed).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('3 rows are eligible'),
      );
      warn.mockRestore();
    });

    it('sends at most `limit` rows', async () => {
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false, limit: 1 }),
      );

      expect(response.processed).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(1);
    });

    it('reports the full eligible count when a limit truncates the batch', async () => {
      googleSheetService.getCandidates.mockResolvedValue(
        Array.from({ length: 3 }, (_unused, index) =>
          buildCandidate({ rowNumber: index + 2 }),
        ),
      );
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false, limit: 2 }),
      );

      expect(response.eligible).toBe(3);
      expect(response.processed).toBe(2);
    });

    it('does not wait between sends when the delay is zero', async () => {
      const spy = jest.spyOn(global, 'setTimeout');
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );

      // Two sends means exactly one gap, never one after the final email.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
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
