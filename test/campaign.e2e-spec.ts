import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { EmailService } from './../src/modules/email';
import { Candidate, GoogleSheetService } from './../src/modules/google-sheet';

const SPREADSHEET_ID = '1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I';
const CONNECTION = {
  spreadsheetId: SPREADSHEET_ID,
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

describe('Campaign endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let googleSheetService: {
    getConnection: jest.Mock;
    getCandidates: jest.Mock;
    connect: jest.Mock;
    updateRow: jest.Mock;
  };
  let emailService: { send: jest.Mock };

  beforeAll(async () => {
    googleSheetService = {
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([buildCandidate({})]),
      connect: jest.fn().mockResolvedValue({ ...CONNECTION, active: true }),
      updateRow: jest.fn().mockResolvedValue(1),
    };
    emailService = {
      send: jest.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleSheetService)
      .useValue(googleSheetService)
      .overrideProvider(EmailService)
      .useValue(emailService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Polls a condition over HTTP so timing never decides an assertion. */
  const waitUntil = async (
    condition: () => Promise<boolean>,
  ): Promise<void> => {
    for (let tick = 0; tick < 200; tick += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('condition was never met');
  };

  /** Reads the single-run lock the same way an operator would. */
  const runningFlag = async (): Promise<boolean> => {
    const response = await request(app.getHttpServer()).get(
      '/api/campaign/status',
    );
    return (response.body as { running: boolean }).running;
  };

  it('POST /api/campaign/connect-sheet registers the spreadsheet', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

    await request(app.getHttpServer())
      .post('/api/campaign/connect-sheet')
      .send({ spreadsheetUrl: url })
      .expect(200)
      .expect({ ...CONNECTION, active: true });

    expect(googleSheetService.connect).toHaveBeenCalledWith({
      spreadsheetUrl: url,
      sheetName: undefined,
    });
  });

  it('POST /api/campaign/connect-sheet rejects a missing body field', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/campaign/connect-sheet')
      .send({})
      .expect(400);

    const body = response.body as { message: string | string[] };
    expect(String(body.message)).toContain('spreadsheetUrl');
  });

  it('POST /api/campaign/connect-sheet rejects unknown body fields', async () => {
    await request(app.getHttpServer())
      .post('/api/campaign/connect-sheet')
      .send({ spreadsheetUrl: 'x', unexpected: true })
      .expect(400);
  });

  it('GET /api/campaign/validate returns counts', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/campaign/validate')
      .expect(200);

    expect(response.body as unknown).toEqual({
      connection: CONNECTION,
      total: 1,
      valid: 1,
      invalid: 0,
      errors: [],
    });
  });

  it('GET /api/campaign/validate reports row-level errors', async () => {
    googleSheetService.getCandidates.mockResolvedValueOnce([
      buildCandidate({ rowNumber: 2 }),
      buildCandidate({ rowNumber: 3, email: 'broken', role: 'QA' }),
    ]);

    const response = await request(app.getHttpServer())
      .get('/api/campaign/validate')
      .expect(200);
    const body = response.body as {
      total: number;
      valid: number;
      invalid: number;
      errors: Array<{ row: number; field: string; message: string }>;
    };

    expect(body.total).toBe(2);
    expect(body.valid).toBe(1);
    expect(body.invalid).toBe(1);
    expect(body.errors).toEqual([
      { row: 3, field: 'email', message: 'email is not a valid email address' },
      {
        row: 3,
        field: 'role',
        message: 'role must be one of: FRONTEND, BACKEND, FULL_STACK',
      },
    ]);
  });

  describe('GET /api/campaign/preview', () => {
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
      ]);
    });

    it('returns counts and rendered previews', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/campaign/preview')
        .expect(200);

      const body = response.body as {
        counts: Record<string, number>;
        eligible: number;
        previews: Array<{ subject: string; body: string; row: number }>;
      };

      expect(body.counts).toEqual({
        total: 3,
        pending: 2,
        processing: 0,
        sent: 1,
        failed: 0,
      });
      expect(body.eligible).toBe(2);
      expect(body.previews[0].subject).toBe(
        'Frontend role at Acme — quick question',
      );
      expect(body.previews[0].body).toContain('Hi Asha,');
      expect(body.previews[1].subject).toBe(
        'Backend role at Globex — quick question',
      );
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('defaults limit to 5 and honours ?limit and ?role', async () => {
      const limited = await request(app.getHttpServer())
        .get('/api/campaign/preview?limit=1')
        .expect(200);

      expect((limited.body as { previews: unknown[] }).previews).toHaveLength(
        1,
      );

      const backend = await request(app.getHttpServer())
        .get('/api/campaign/preview?role=BACKEND&type=follow_up')
        .expect(200);

      const body = backend.body as {
        previews: Array<{ role: string; subject: string }>;
      };
      expect(body.previews).toHaveLength(1);
      expect(body.previews[0].role).toBe('BACKEND');
      expect(body.previews[0].subject).toBe('Re: Backend role at Globex');
    });

    it('rejects an unknown role or type', async () => {
      await request(app.getHttpServer())
        .get('/api/campaign/preview?role=DESIGNER')
        .expect(400);

      await request(app.getHttpServer())
        .get('/api/campaign/preview?type=invoice')
        .expect(400);
    });
  });

  describe('POST /api/campaign/send', () => {
    beforeEach(() => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
      ]);
      googleSheetService.updateRow.mockClear();
      emailService.send.mockClear();
    });

    /** A real send is answered before the batch finishes. */
    const waitForIdleRun = async (): Promise<void> => {
      await waitUntil(async () => !(await runningFlag()));
    };

    it('is a dry run by default', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/campaign/send')
        .expect(200);

      const body = response.body as {
        status: string;
        dryRun: boolean;
        results: Array<{ status: string }>;
      };
      expect(body.dryRun).toBe(true);
      expect(body.status).toBe('DRY_RUN_COMPLETED');
      expect(body.results[0].status).toBe('DRY_RUN');
      expect(emailService.send).not.toHaveBeenCalled();
      expect(googleSheetService.updateRow).not.toHaveBeenCalled();
    });

    it('treats dryRun=true the same way', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/campaign/send?dryRun=true')
        .expect(200);

      expect((response.body as { dryRun: boolean }).dryRun).toBe(true);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('answers STARTED and writes state back when dryRun=false', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/campaign/send?dryRun=false')
        .expect(200);

      const body = response.body as {
        status: string;
        campaignId: string;
        total: number;
      };
      expect(body.status).toBe('STARTED');
      expect(body.total).toBe(1);
      expect(body.campaignId).toMatch(/^campaign-\d{8}-\d{3}$/);

      await waitForIdleRun();

      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(googleSheetService.updateRow).toHaveBeenNthCalledWith(
        1,
        2,
        expect.objectContaining({ status: 'PROCESSING' }),
      );
      expect(googleSheetService.updateRow).toHaveBeenNthCalledWith(
        2,
        2,
        expect.objectContaining({ status: 'SENT', message_id: 'msg-1' }),
      );
    });

    it('rejects a non-boolean dryRun value', async () => {
      await request(app.getHttpServer())
        .post('/api/campaign/send?dryRun=maybe')
        .expect(400);
    });
  });

  describe('GET /api/campaign/status', () => {
    beforeEach(() => {
      googleSheetService.getCandidates.mockResolvedValue([
        buildCandidate({ rowNumber: 2 }),
        buildCandidate({ rowNumber: 3, status: 'SENT' }),
        buildCandidate({
          rowNumber: 4,
          status: 'FAILED',
          followUpEnabled: 'YES',
        }),
      ]);
    });

    it('returns live counts, follow-up counts and the run state', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/campaign/status')
        .expect(200);

      expect(response.body as unknown).toEqual({
        connection: CONNECTION,
        counts: {
          total: 3,
          pending: 1,
          processing: 0,
          sent: 1,
          failed: 1,
        },
        followUp: {
          notScheduled: 3,
          scheduled: 0,
          processing: 0,
          sent: 0,
          failed: 0,
          enabled: 1,
        },
        running: false,
        activeCampaignId: null,
      });
    });
  });

  it('POST /api/campaign/send answers 409 while a run is in flight', async () => {
    let release!: (value: { messageId: string }) => void;
    emailService.send.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    googleSheetService.getCandidates.mockResolvedValue([
      buildCandidate({ rowNumber: 2 }),
    ]);

    let firstStatus = 0;
    const first = request(app.getHttpServer())
      .post('/api/campaign/send?dryRun=false')
      .then((response) => {
        firstStatus = response.status;
      });

    await waitUntil(runningFlag);

    await request(app.getHttpServer())
      .post('/api/campaign/send?dryRun=false')
      .expect(409);

    release({ messageId: 'msg-1' });
    await first;
    expect(firstStatus).toBe(200);
  });
});
