import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { EmailService } from './../src/modules/email';
import { Candidate, GoogleSheetService } from './../src/modules/google-sheet';

const API_KEY = 'e2e-secret-key';
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
 * The global API key guard, proven over HTTP. `ConfigModule` reads the
 * environment when the module is compiled, so the key is set before `compile()`
 * — which is why this cannot share a suite with the "no key configured" case.
 */
describe('API key guard (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;

    const googleSheetService = {
      getConnection: jest.fn().mockReturnValue(CONNECTION),
      getCandidates: jest.fn().mockResolvedValue([buildCandidate({})]),
      checkConnectivity: jest
        .fn()
        .mockResolvedValue({ ...CONNECTION, sheetNames: ['Candidates'] }),
    };
    const emailService = {
      verify: jest.fn().mockResolvedValue({
        verified: true,
        provider: 'nodemailer',
        host: 'smtp.gmail.com',
        user: 'me@gmail.com',
      }),
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
    delete process.env.API_KEY;
  });

  it('rejects a request with no key, naming the header to use', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/campaign/status')
      .expect(401);

    expect(String((response.body as { message: string }).message)).toContain(
      'x-api-key',
    );
  });

  it('rejects a request with the wrong key', async () => {
    await request(app.getHttpServer())
      .get('/api/campaign/status')
      .set('x-api-key', 'not-the-key')
      .expect(401);
  });

  it('accepts the right key, as a header or a bearer token', async () => {
    await request(app.getHttpServer())
      .get('/api/campaign/status')
      .set('x-api-key', API_KEY)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/campaign/status')
      .set('authorization', `Bearer ${API_KEY}`)
      .expect(200);
  });

  it('protects the send endpoint too, not just reads', async () => {
    await request(app.getHttpServer()).post('/api/campaign/send').expect(401);
  });

  it('leaves GET /health reachable without a key', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});
