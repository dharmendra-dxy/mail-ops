import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email';
import { GoogleSheetService } from '../google-sheet';
import {
  HEALTH_CHECK_NAMES,
  HEALTH_CHECK_STATUS,
  HEALTH_STATUS,
} from './health.constant';
import { HealthService } from './health.service';

const CONNECTION = {
  spreadsheetId: '1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I',
  sheetName: 'Candidates',
  driver: 'apps_script',
};

describe('HealthService', () => {
  let googleSheetService: { checkConnectivity: jest.Mock };
  let emailService: { verify: jest.Mock };
  let configValues: Record<string, unknown>;
  let service: HealthService;

  beforeEach(() => {
    googleSheetService = {
      checkConnectivity: jest
        .fn()
        .mockResolvedValue({ ...CONNECTION, sheetNames: ['Candidates'] }),
    };
    emailService = {
      verify: jest.fn().mockResolvedValue({
        verified: true,
        provider: 'nodemailer',
        host: 'smtp.gmail.com',
        user: 'me@gmail.com',
      }),
    };
    configValues = { 'app.healthCheckTimeoutMs': 500 };

    service = new HealthService(
      googleSheetService as unknown as GoogleSheetService,
      emailService as unknown as EmailService,
      {
        get: (key: string, fallback?: unknown) =>
          key in configValues ? configValues[key] : fallback,
      } as unknown as ConfigService,
    );
  });

  it('reports up when both dependencies answer', async () => {
    const report = await service.check();

    expect(report.status).toBe(HEALTH_STATUS.UP);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: HEALTH_CHECK_NAMES.GOOGLE_SHEET,
        status: HEALTH_CHECK_STATUS.UP,
      }),
      expect.objectContaining({
        name: HEALTH_CHECK_NAMES.EMAIL,
        status: HEALTH_CHECK_STATUS.UP,
      }),
    ]);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports degraded with the reason when the sheet is unreachable', async () => {
    googleSheetService.checkConnectivity.mockRejectedValue(
      new Error('Apps Script returned 401'),
    );

    const report = await service.check();
    const [sheet, email] = report.checks;

    expect(report.status).toBe(HEALTH_STATUS.DEGRADED);
    expect(sheet.status).toBe(HEALTH_CHECK_STATUS.DOWN);
    expect(sheet.detail).toContain('Apps Script returned 401');
    // One dependency failing must not hide the other.
    expect(email.status).toBe(HEALTH_CHECK_STATUS.UP);
  });

  it('reports degraded when the mail credentials are rejected', async () => {
    emailService.verify.mockRejectedValue(
      new Error('Could not authenticate with smtp.gmail.com: 535 bad login'),
    );

    const report = await service.check();

    expect(report.status).toBe(HEALTH_STATUS.DEGRADED);
    expect(report.checks[1]).toMatchObject({
      name: HEALTH_CHECK_NAMES.EMAIL,
      status: HEALTH_CHECK_STATUS.DOWN,
    });
  });

  it('collapses a multi-line provider error into one readable line', async () => {
    emailService.verify.mockRejectedValue(
      new Error('Connection failed:\n  at TCPConnectWrap\n  at listOnTimeout'),
    );

    const report = await service.check();

    expect(report.checks[1].detail).toBe(
      'Connection failed: at TCPConnectWrap at listOnTimeout',
    );
  });

  it('times out a hung probe instead of hanging the health endpoint', async () => {
    jest.useFakeTimers();
    googleSheetService.checkConnectivity.mockReturnValue(
      new Promise(() => undefined),
    );

    const pending = service.check();
    await jest.advanceTimersByTimeAsync(500);
    const report = await pending;
    jest.useRealTimers();

    expect(report.status).toBe(HEALTH_STATUS.DEGRADED);
    expect(report.checks[0].detail).toContain('no response within 500ms');
  });

  it('never rejects, whatever the dependencies do', async () => {
    googleSheetService.checkConnectivity.mockRejectedValue('plain string');
    emailService.verify.mockRejectedValue(undefined);

    await expect(service.check()).resolves.toMatchObject({
      status: HEALTH_STATUS.DEGRADED,
    });
  });

  it('warns when the configured tab is missing, even when the sheet answers', async () => {
    googleSheetService.checkConnectivity.mockResolvedValue({
      ...CONNECTION,
      sheetNames: ['Archive'],
    });

    const report = await service.check();

    // Reachable is not the same as usable: a wrong SHEET_NAME would fail every
    // campaign, so the detail says so.
    expect(report.status).toBe(HEALTH_STATUS.UP);
    expect(report.checks[0].detail).toContain('"Candidates" missing');
  });
});
