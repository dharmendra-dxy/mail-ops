import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { EmailService } from './../src/modules/email';
import { Candidate, GoogleSheetService } from './../src/modules/google-sheet';

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

/**
 * `GET /health` and the default (no API key) request path. The API-key-enabled
 * case lives in `api-key.e2e-spec.ts`, because `ConfigModule` reads the
 * environment once per process and cannot be flipped per suite.
 */
describe('Health endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let googleSheetService: {
    checkConnectivity: jest.Mock;
    getConnection: jest.Mock;
    getCandidates: jest.Mock;
  };
  let emailService: { verify: jest.Mock };

  beforeAll(async () => {
    googleSheetService = {
      checkConnectivity: jest
        .fn()
        .mockResolvedValue({ ...CONNECTION, sheetNames: ['Candidates'] }),
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([buildCandidate({})]),
    };
    emailService = {
      verify: jest.fn().mockResolvedValue({
        verified: true,
        provider: 'nodemailer',
        host: 'smtp.gmail.com',
        user: 'me@gmail.com',
      }),
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

  it('answers 200 with a per-dependency report when everything is up', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    expect(response.body as unknown).toMatchObject({
      status: 'up',
      checks: [
        { name: 'googleSheet', status: 'up' },
        { name: 'email', status: 'up' },
      ],
    });
  });

  it('answers 503 but still names the failing dependency', async () => {
    googleSheetService.checkConnectivity.mockRejectedValueOnce(
      new Error('Apps Script returned 401'),
    );

    const response = await request(app.getHttpServer())
      .get('/api/health')
      .expect(503);

    const body = response.body as {
      status: string;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(body.status).toBe('degraded');
    expect(body.checks[0]).toMatchObject({
      name: 'googleSheet',
      status: 'down',
    });
    expect(body.checks[0].detail).toContain('Apps Script returned 401');
  });

  it('leaves the API open when no key is configured, so local dev needs no setup', async () => {
    await request(app.getHttpServer()).get('/api/campaign/status').expect(200);
  });
});
