import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
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
  };

  beforeAll(async () => {
    googleSheetService = {
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([buildCandidate({})]),
      connect: jest.fn().mockResolvedValue({ ...CONNECTION, active: true }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleSheetService)
      .useValue(googleSheetService)
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
});
