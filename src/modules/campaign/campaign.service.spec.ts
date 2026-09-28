import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from '../email';
import { Candidate, GoogleSheetService, SHEET_COLUMNS } from '../google-sheet';
import { TemplateService } from '../template';
import { CampaignService } from './campaign.service';
import {
  CampaignSendResponse,
  CampaignStartResponse,
  CampaignStatusResponse,
} from './campaign.types';
import { PreviewCandidatesDto } from './dto/preview-candidates.dto';
import { SendCampaignDto } from './dto/send-campaign.dto';

const CONNECTION = {
  spreadsheetId: '1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I',
  sheetName: 'Candidates',
  driver: 'apps_script',
};

const MINUTE_MS = 60_000;

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

  /**
   * A real send continues after the HTTP response, so tests wait for the lock to
   * be released rather than for the request to return.
   */
  const waitForIdle = async (): Promise<void> => {
    for (let tick = 0; tick < 200; tick += 1) {
      if (!(await service.getStatus()).running) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('campaign run did not finish');
  };

  /** Lets a test hold a run open instead of racing a timer. */
  const deferred = (): {
    promise: Promise<{ messageId: string }>;
    resolve: (value: { messageId: string }) => void;
  } => {
    let resolve!: (value: { messageId: string }) => void;
    const promise = new Promise<{ messageId: string }>((inner) => {
      resolve = inner;
    });

    return { promise, resolve };
  };

  const startRealSend = async (
    overrides: Partial<SendCampaignDto> = {},
  ): Promise<CampaignStartResponse> => {
    const response = (await service.send(
      Object.assign(new SendCampaignDto(), { dryRun: false, ...overrides }),
    )) as CampaignStartResponse;
    await waitForIdle();

    return response;
  };

  const dryRun = async (
    overrides: Partial<SendCampaignDto> = {},
  ): Promise<CampaignSendResponse> =>
    (await service.send(
      Object.assign(new SendCampaignDto(), { dryRun: true, ...overrides }),
    )) as CampaignSendResponse;

  const patchOf = (call: number): Record<string, unknown> =>
    (
      googleSheetService.updateRow.mock.calls[call] as unknown as [
        number,
        Record<string, unknown>,
      ]
    )[1];

  const rowOf = (call: number): number =>
    (
      googleSheetService.updateRow.mock.calls[call] as unknown as [
        number,
        Record<string, unknown>,
      ]
    )[0];

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
      'campaign.emailMaxRetries': 2,
      'campaign.staleProcessingThresholdMinutes': 30,
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

  describe('getStatus', () => {
    it('aggregates initial and follow-up counts from the live sheet', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({ rowNumber: 3, status: 'PROCESSING' }),
        buildCandidate({ rowNumber: 4, status: 'SENT' }),
        buildCandidate({ rowNumber: 5, status: 'FAILED' }),
        buildCandidate({
          rowNumber: 6,
          followUpEnabled: 'YES',
          followUpStatus: 'SCHEDULED',
        }),
        buildCandidate({ rowNumber: 7, followUpStatus: 'SENT' }),
      ]);

      const status: CampaignStatusResponse = await service.getStatus();

      expect(status.counts).toEqual({
        total: 6,
        pending: 3,
        processing: 1,
        sent: 1,
        failed: 1,
      });
      expect(status.followUp).toEqual({
        notScheduled: 4,
        scheduled: 1,
        processing: 0,
        sent: 1,
        failed: 0,
        enabled: 1,
      });
      expect(status.running).toBe(false);
      expect(status.activeCampaignId).toBeNull();
    });
  });

  describe('send (dry run)', () => {
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
      const response = (await service.send(
        new SendCampaignDto(),
      )) as CampaignSendResponse;

      expect(response.status).toBe('DRY_RUN_COMPLETED');
      expect(response.dryRun).toBe(true);
      expect(response.campaignId).toMatch(/^campaign-\d{8}-dry$/);
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

    it('never consumes a campaign sequence number', async () => {
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      await dryRun();

      const started = await startRealSend({ limit: 1 });

      expect(started.campaignId).toMatch(/^campaign-\d{8}-001$/);
    });

    it('releases the run lock so the next send is accepted', async () => {
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      await dryRun();

      const status = await service.getStatus();

      expect(status.running).toBe(false);
      await expect(startRealSend({ limit: 1 })).resolves.toMatchObject({
        status: 'STARTED',
      });
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

      const response = await dryRun({ limit: 2 });

      expect(response.eligible).toBe(3);
      expect(response.processed).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('3 rows are eligible'),
      );
      warn.mockRestore();
    });

    it('defaults to a full batch of 50 rows', () => {
      expect(new SendCampaignDto().limit).toBe(50);
      expect(new PreviewCandidatesDto().limit).toBe(5);
    });
  });

  describe('send (real run)', () => {
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

    it('answers STARTED immediately with the batch size and campaign id', async () => {
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const response = await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );
      const started = response as CampaignStartResponse;

      expect(started.status).toBe('STARTED');
      expect(started.dryRun).toBe(false);
      expect(started.total).toBe(2);
      expect(started.campaignId).toMatch(/^campaign-\d{8}-001$/);
      expect(started.connection).toEqual(CONNECTION);

      await waitForIdle();
    });

    it('drives each row through PROCESSING then SENT', async () => {
      emailService.send
        .mockResolvedValueOnce({ messageId: 'msg-1' })
        .mockResolvedValueOnce({ messageId: 'msg-2' });

      const started = await startRealSend();

      // Two writes per row: the PROCESSING lock, then the settled outcome.
      expect(googleSheetService.updateRow).toHaveBeenCalledTimes(4);

      expect(rowOf(0)).toBe(2);
      expect(patchOf(0)).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'PROCESSING',
        [SHEET_COLUMNS.CAMPAIGN_ID]: started.campaignId,
      });
      expect(patchOf(0)[SHEET_COLUMNS.PROCESSING_STARTED_AT]).toEqual(
        expect.any(String),
      );

      expect(rowOf(1)).toBe(2);
      expect(patchOf(1)).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'SENT',
        [SHEET_COLUMNS.MESSAGE_ID]: 'msg-1',
        [SHEET_COLUMNS.ERROR]: '',
        [SHEET_COLUMNS.ATTEMPTS]: 1,
      });
      expect(patchOf(1)[SHEET_COLUMNS.SENT_AT]).toEqual(expect.any(String));

      expect(rowOf(2)).toBe(3);
      expect(patchOf(2)).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'PROCESSING',
        [SHEET_COLUMNS.CAMPAIGN_ID]: started.campaignId,
      });
      expect(patchOf(3)).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'SENT',
        [SHEET_COLUMNS.MESSAGE_ID]: 'msg-2',
      });

      expect(emailService.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          to: 'asha@example.com',
          subject: 'Frontend role at Acme — quick question',
        }),
      );
    });

    it('stamps campaign_id on FAILED rows too', async () => {
      emailService.send.mockRejectedValue(new Error('550 mailbox unavailable'));

      const started = await startRealSend();

      const failedPatches = googleSheetService.updateRow.mock.calls
        .map(
          (call) => (call as unknown as [number, Record<string, unknown>])[1],
        )
        .filter(
          (patch) =>
            patch[SHEET_COLUMNS.STATUS] === 'FAILED' &&
            patch[SHEET_COLUMNS.CAMPAIGN_ID] !== undefined,
        );

      expect(failedPatches).toHaveLength(2);
      expect(failedPatches[0][SHEET_COLUMNS.CAMPAIGN_ID]).toBe(
        started.campaignId,
      );
    });

    it('never re-sends a row that is already SENT', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({ rowNumber: 3, status: 'SENT' }),
        buildCandidate({ rowNumber: 4, status: 'FAILED' }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const started = await startRealSend();

      expect(started.total).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(1);
    });

    it('rejects a concurrent run with 409 Conflict', async () => {
      // Holding the provider open keeps the first run in flight.
      const gate = deferred();
      emailService.send.mockReturnValue(gate.promise);

      const first = service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );

      const conflict = await service
        .send(Object.assign(new SendCampaignDto(), { dryRun: false }))
        .catch((error: ConflictException) => error);

      expect(conflict).toBeInstanceOf(ConflictException);
      expect((conflict as ConflictException).getStatus()).toBe(409);
      expect((conflict as ConflictException).message).toContain(
        'already running',
      );

      gate.resolve({ messageId: 'msg-1' });
      await first;
      await waitForIdle();
    });

    it('rejects a dry run while a real run is in flight', async () => {
      const gate = deferred();
      emailService.send.mockReturnValue(gate.promise);

      const first = service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );

      await expect(service.send(new SendCampaignDto())).rejects.toMatchObject({
        status: 409,
      });

      gate.resolve({ messageId: 'msg-1' });
      await first;
      await waitForIdle();
    });

    it('continues past a failing row and waits EMAIL_DELAY_MS between sends', async () => {
      configValues['campaign.emailDelayMs'] = 7;
      emailService.send
        .mockResolvedValueOnce({ messageId: 'msg-1' })
        .mockRejectedValueOnce(new Error('450 mailbox busy'));
      const spy = jest.spyOn(global, 'setTimeout');

      const response = (await service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      )) as CampaignStartResponse;
      await waitForIdle();

      expect(response.status).toBe('STARTED');
      expect(emailService.send).toHaveBeenCalledTimes(2);
      const statuses = googleSheetService.updateRow.mock.calls.map(
        (call) =>
          (call as unknown as [number, Record<string, unknown>])[1][
            SHEET_COLUMNS.STATUS
          ],
      );
      expect(statuses).toEqual(['PROCESSING', 'SENT', 'PROCESSING', 'FAILED']);
      // Two sends means exactly one gap, never one after the final email.
      expect(spy.mock.calls.filter(([, ms]) => ms === 7)).toHaveLength(1);
      spy.mockRestore();
    });

    it('sends at most `limit` rows and reports the full eligible count', async () => {
      googleSheetService.getCandidates.mockResolvedValue(
        Array.from({ length: 3 }, (_unused, index) =>
          buildCandidate({ rowNumber: index + 2 }),
        ),
      );
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const started = await startRealSend({ limit: 2 });

      expect(started.total).toBe(2);
      expect(emailService.send).toHaveBeenCalledTimes(2);
    });

    it('numbers a second campaign after the ids already on the sheet', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({
          rowNumber: 2,
          status: 'SENT',
          campaignId: 'campaign-20260101-009',
        }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      await startRealSend();

      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({
          rowNumber: 2,
          status: 'SENT',
          campaignId: `campaign-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-004`,
        }),
        buildCandidate({ rowNumber: 3 }),
      ]);

      const second = await startRealSend();

      expect(second.campaignId).toMatch(/-005$/);
    });
  });

  describe('error handling and retries', () => {
    beforeEach(() => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
      ]);
    });

    it('retries a retryable failure and succeeds within the budget', async () => {
      emailService.send
        .mockRejectedValueOnce(new Error('ETIMEDOUT connection timed out'))
        .mockResolvedValueOnce({ messageId: 'msg-1' });

      await startRealSend();

      expect(emailService.send).toHaveBeenCalledTimes(2);
      const patches = googleSheetService.updateRow.mock.calls.map(
        (call) => (call as unknown as [number, Record<string, unknown>])[1],
      );
      expect(patches[patches.length - 1]).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'SENT',
        [SHEET_COLUMNS.ATTEMPTS]: 2,
      });
    });

    it('does not retry a permanent failure', async () => {
      emailService.send.mockRejectedValue(
        new Error(
          '550 5.1.1 The email account that you tried to reach does not exist',
        ),
      );

      await startRealSend();

      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(
        patchOf(googleSheetService.updateRow.mock.calls.length - 1),
      ).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'FAILED',
        [SHEET_COLUMNS.ATTEMPTS]: 1,
      });
    });

    it('gives up after EMAIL_MAX_RETRIES and records the last reason', async () => {
      emailService.send.mockRejectedValue(new Error('503 service unavailable'));

      await startRealSend();

      // 1 initial attempt + 2 retries.
      expect(emailService.send).toHaveBeenCalledTimes(3);
      const last = googleSheetService.updateRow.mock.calls.at(
        -1,
      ) as unknown as [number, Record<string, unknown>];
      expect(last[1]).toMatchObject({
        [SHEET_COLUMNS.STATUS]: 'FAILED',
        [SHEET_COLUMNS.ERROR]: '503 service unavailable',
        [SHEET_COLUMNS.ATTEMPTS]: 3,
      });
      expect(last[1][SHEET_COLUMNS.CAMPAIGN_ID]).toEqual(expect.any(String));
    });

    it('skips a PENDING row that already used its whole attempt budget', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2, attempts: 3 }),
      ]);
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const started = await startRealSend();

      expect(started.total).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('already used all 3 attempts'),
      );
      warn.mockRestore();
    });

    it('marks a row FAILED without PROCESSING when the template cannot render', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2, role: 'DESIGNER' }),
      ]);
      const started = await startRealSend();

      expect(started.total).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('never re-sends when the settle write after a successful send fails', async () => {
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });
      googleSheetService.updateRow.mockImplementation(
        (row: number, patch: Record<string, unknown>) => {
          if (patch[SHEET_COLUMNS.STATUS] === 'SENT') {
            return Promise.reject(new Error('sheet unreachable'));
          }
          return Promise.resolve(1);
        },
      );

      await startRealSend();

      // One delivery, one aborted run: a lost state write must not become a
      // second email.
      expect(emailService.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale PROCESSING recovery', () => {
    it('re-sends a row stuck in PROCESSING past the threshold', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({
          rowNumber: 2,
          status: 'PROCESSING',
          processingStartedAt: new Date(
            Date.now() - 45 * MINUTE_MS,
          ).toISOString(),
        }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const started = await startRealSend();

      expect(started.total).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('stale PROCESSING row(s): 2'),
      );
      warn.mockRestore();
    });

    it('leaves a row in PROCESSING alone while it is still inside the threshold', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({
          rowNumber: 2,
          status: 'PROCESSING',
          processingStartedAt: new Date(
            Date.now() - 2 * MINUTE_MS,
          ).toISOString(),
        }),
      ]);

      const started = await startRealSend();

      expect(started.total).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('recovers a PROCESSING row with no timestamp at all', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2, status: 'PROCESSING' }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const started = await startRealSend();

      expect(started.total).toBe(1);
    });
  });

  it('releases the run lock when a campaign is aborted', async () => {
    googleSheetService.getCandidates.mockResolvedValue([
      buildCandidate({ rowNumber: 2 }),
    ]);
    googleSheetService.updateRow.mockRejectedValue(
      new Error('sheet unreachable'),
    );

    await startRealSend();

    await expect(service.getStatus()).resolves.toMatchObject({
      running: false,
      activeCampaignId: null,
    });
  });

  describe('follow-ups', () => {
    const DAY_MS = 86_400_000;

    /** A row that already received its initial email, days ago. */
    const sentCandidate = (overrides: Partial<Candidate> = {}): Candidate =>
      buildCandidate({
        status: 'SENT',
        sentAt: new Date(Date.now() - 5 * DAY_MS).toISOString(),
        messageId: '<initial-1@example.com>',
        followUpEnabled: 'YES',
        followUpDays: 3,
        ...overrides,
      });

    it('promotes a due row to SCHEDULED, then sends the follow_up template', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ rowNumber: 2, followUpStatus: 'NOT_SCHEDULED' }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'follow-up-1' });

      const result = await service.processFollowUps();

      expect(result).toMatchObject({
        eligible: 1,
        processed: 1,
        sent: 1,
        failed: 0,
        skipped: null,
        promoted: 1,
      });

      // The promotion is its own write, so it stays visible even on a day
      // where the follow-up is not due yet.
      expect(rowOf(0)).toBe(2);
      expect(patchOf(0)).toEqual({
        [SHEET_COLUMNS.FOLLOW_UP_STATUS]: 'SCHEDULED',
      });

      expect(patchOf(1)).toMatchObject({
        [SHEET_COLUMNS.FOLLOW_UP_STATUS]: 'PROCESSING',
        [SHEET_COLUMNS.CAMPAIGN_ID]: result.campaignId,
      });
      expect(patchOf(2)).toMatchObject({
        [SHEET_COLUMNS.FOLLOW_UP_STATUS]: 'SENT',
        [SHEET_COLUMNS.FOLLOW_UP_MESSAGE_ID]: 'follow-up-1',
        [SHEET_COLUMNS.ERROR]: '',
      });
      expect(patchOf(2)[SHEET_COLUMNS.FOLLOW_UP_SENT_AT]).toEqual(
        expect.any(String),
      );

      // The initial record must not be touched by the follow-up.
      expect(patchOf(2)[SHEET_COLUMNS.STATUS]).toBeUndefined();
      expect(patchOf(2)[SHEET_COLUMNS.SENT_AT]).toBeUndefined();

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'asha@example.com',
          subject: 'Re: Frontend role at Acme',
          inReplyTo: '<initial-1@example.com>',
        }),
      );
    });

    it('sends on the very next tick when follow_up_days is 0', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ followUpDays: 0, followUpStatus: 'SCHEDULED' }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'follow-up-1' });

      const result = await service.processFollowUps();

      expect(result.sent).toBe(1);
    });

    it('waits until sent_at + follow_up_days', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({
          sentAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
          followUpDays: 7,
          followUpStatus: 'SCHEDULED',
        }),
      ]);

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('ignores rows that did not opt in or whose initial email is not SENT', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ rowNumber: 2, followUpEnabled: 'NO' }),
        buildCandidate({ rowNumber: 3, followUpEnabled: 'YES' }),
        buildCandidate({
          rowNumber: 4,
          status: 'FAILED',
          followUpEnabled: 'YES',
        }),
      ]);

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('never sends the same follow-up twice', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({
          followUpStatus: 'SENT',
          followUpSentAt: new Date().toISOString(),
        }),
      ]);

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does not auto-retry a FAILED follow-up', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ followUpStatus: 'FAILED', error: '550 no such user' }),
      ]);
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('follow-up already FAILED'),
      );
      warn.mockRestore();
    });

    it('recovers a stale follow-up PROCESSING row and leaves a fresh one alone', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({
          rowNumber: 2,
          followUpStatus: 'PROCESSING',
          processingStartedAt: new Date(
            Date.now() - 45 * MINUTE_MS,
          ).toISOString(),
        }),
        sentCandidate({
          rowNumber: 3,
          followUpStatus: 'PROCESSING',
          processingStartedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
        }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'follow-up-1' });

      const result = await service.processFollowUps();

      expect(result.sent).toBe(1);
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'asha@example.com' }),
      );
    });

    it('reports a row whose timing cannot be read instead of sending blindly', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ sentAt: 'not-a-date' }),
        sentCandidate({ rowNumber: 3, followUpDays: Number.NaN }),
      ]);
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unusable sent_at or follow_up_days: 2, 3'),
      );
      warn.mockRestore();
    });

    it('retries a retryable failure and marks the follow-up FAILED otherwise', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ rowNumber: 2, followUpStatus: 'SCHEDULED' }),
      ]);
      emailService.send
        .mockRejectedValueOnce(new Error('ETIMEDOUT connection timed out'))
        .mockResolvedValueOnce({ messageId: 'follow-up-1' });

      const recovered = await service.processFollowUps();

      expect(recovered.sent).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(2);

      googleSheetService.updateRow.mockClear();
      emailService.send.mockReset();
      emailService.send.mockRejectedValue(
        new Error(
          '550 5.1.1 The email account that you tried to reach does not exist',
        ),
      );

      const failed = await service.processFollowUps();

      expect(failed.failed).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(
        patchOf(googleSheetService.updateRow.mock.calls.length - 1),
      ).toMatchObject({
        [SHEET_COLUMNS.FOLLOW_UP_STATUS]: 'FAILED',
        [SHEET_COLUMNS.ERROR]:
          '550 5.1.1 The email account that you tried to reach does not exist',
      });
    });

    it('skips a follow-up for a row that fails sheet validation', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ email: 'not-an-email' }),
      ]);

      const result = await service.processFollowUps();

      expect(result.eligible).toBe(0);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('honours the batch limit and leaves the rest for the next run', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        sentCandidate({ rowNumber: 2 }),
        sentCandidate({ rowNumber: 3, email: 'vikram@globex.com' }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'follow-up-1' });

      const result = await service.processFollowUps({ limit: 1 });

      expect(result.eligible).toBe(1);
      expect(result.sent).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('runDailyCycle', () => {
    const DAY_MS = 86_400_000;

    it('sends due initial emails, then due follow-ups, under one lock', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({
          rowNumber: 3,
          email: 'hr@globex.com',
          status: 'SENT',
          sentAt: new Date(Date.now() - 5 * DAY_MS).toISOString(),
          messageId: '<initial-3@example.com>',
          followUpEnabled: 'YES',
          followUpDays: 3,
          followUpStatus: 'SCHEDULED',
        }),
      ]);
      emailService.send
        .mockResolvedValueOnce({ messageId: 'msg-1' })
        .mockResolvedValueOnce({ messageId: 'follow-up-1' });

      const result = await service.runDailyCycle();

      expect(result.skipped).toBeNull();
      expect(result.initial).toMatchObject({ sent: 1, failed: 0, eligible: 1 });
      expect(result.followUp).toMatchObject({
        sent: 1,
        failed: 0,
        eligible: 1,
      });
      expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(
        Date.parse(result.startedAt),
      );

      expect(emailService.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          subject: 'Frontend role at Acme — quick question',
        }),
      );
      expect(emailService.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ subject: 'Re: Frontend role at Acme' }),
      );
    });

    it('numbers each half of the cycle from the ids already on the sheet', async () => {
      // A stateful sheet: the follow-up half must see the campaign id the
      // initial half just stamped, exactly as a real re-read would.
      const rows = [
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({
          rowNumber: 3,
          status: 'SENT',
          sentAt: new Date(Date.now() - DAY_MS).toISOString(),
          followUpEnabled: 'YES',
          followUpDays: 0,
          followUpStatus: 'SCHEDULED',
        }),
      ];
      googleSheetService.getCandidates.mockImplementation(() =>
        Promise.resolve(rows.map((row) => Object.assign(new Candidate(), row))),
      );
      googleSheetService.updateRow.mockImplementation(
        (rowNumber: number, patch: Record<string, unknown>) => {
          const target = rows.find(
            (row) => row.rowNumber === rowNumber,
          ) as Candidate;
          // Patches are keyed by sheet column; the entity uses camelCase.
          Object.assign(target, {
            ...patch,
            campaignId: patch[SHEET_COLUMNS.CAMPAIGN_ID] ?? target.campaignId,
          });
          return 1;
        },
      );
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const result = await service.runDailyCycle();

      expect(result.initial.campaignId).toMatch(/-001$/);
      expect(result.followUp.campaignId).toMatch(/-002$/);
    });

    it('is a no-op on an empty sheet and still releases the lock', async () => {
      const result = await service.runDailyCycle();

      expect(result).toMatchObject({
        skipped: null,
        initial: { eligible: 0, campaignId: null },
        followUp: { eligible: 0, campaignId: null },
        promoted: 0,
      });
      expect(emailService.send).not.toHaveBeenCalled();
      await expect(service.getStatus()).resolves.toMatchObject({
        running: false,
      });
    });

    it('skips the cycle when a manual run already holds the lock', async () => {
      const gate = deferred();
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
      ]);
      emailService.send.mockReturnValue(gate.promise);

      const manual = service.send(
        Object.assign(new SendCampaignDto(), { dryRun: false }),
      );
      const skipped = await service.runDailyCycle();

      expect(skipped.skipped).toBe('RUN_IN_PROGRESS');
      expect(skipped.initial.sent).toBe(0);
      expect(skipped.followUp.sent).toBe(0);

      gate.resolve({ messageId: 'msg-1' });
      await manual;
      await waitForIdle();
    });

    it('applies the batch limit to each half independently', async () => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({ rowNumber: 3, email: 'hr@globex.com' }),
        buildCandidate({
          rowNumber: 4,
          status: 'SENT',
          sentAt: new Date(Date.now() - DAY_MS).toISOString(),
          followUpEnabled: 'YES',
          followUpDays: 0,
          followUpStatus: 'SCHEDULED',
        }),
        buildCandidate({
          rowNumber: 5,
          email: 'talent@initech.com',
          status: 'SENT',
          sentAt: new Date(Date.now() - DAY_MS).toISOString(),
          followUpEnabled: 'YES',
          followUpDays: 0,
          followUpStatus: 'SCHEDULED',
        }),
      ]);
      emailService.send.mockResolvedValue({ messageId: 'msg-1' });

      const result = await service.runDailyCycle({ limit: 1 });

      expect(result.initial.sent).toBe(1);
      expect(result.followUp.sent).toBe(1);
      expect(emailService.send).toHaveBeenCalledTimes(2);
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
