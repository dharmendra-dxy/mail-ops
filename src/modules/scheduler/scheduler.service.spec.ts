import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { CronJob } from 'cron';
import { CampaignService } from '../campaign';
import { SchedulerService } from './scheduler.service';
import { DEFAULT_CRON_JOB_NAME } from './scheduler.constant';

interface FakeRegistry {
  addCronJob: jest.Mock;
  deleteCronJob: jest.Mock;
  getCronJob: jest.Mock;
  doesExist: jest.Mock;
  jobs: Map<string, CronJob>;
}

describe('SchedulerService', () => {
  let service: SchedulerService;
  let campaignService: { runDailyCycle: jest.Mock };
  let registry: FakeRegistry;
  let configValues: Record<string, unknown>;

  const buildService = async (): Promise<SchedulerService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: CampaignService, useValue: campaignService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key in configValues ? configValues[key] : fallback,
          },
        },
        { provide: SchedulerRegistry, useValue: registry },
      ],
    }).compile();

    return module.get(SchedulerService);
  };

  beforeEach(async () => {
    // Mirrors the real registry: `deleteCronJob` throws for an unknown name.
    registry = {
      addCronJob: jest.fn((name: string, job: CronJob) => {
        registry.jobs.set(name, job);
      }),
      deleteCronJob: jest.fn((name: string) => {
        if (!registry.jobs.has(name)) throw new Error(`no cron job ${name}`);
        registry.jobs.delete(name);
      }),
      getCronJob: jest.fn(),
      doesExist: jest.fn((_type: string, name: string) =>
        registry.jobs.has(name),
      ),
      jobs: new Map<string, CronJob>(),
    };
    campaignService = {
      runDailyCycle: jest.fn().mockResolvedValue({
        startedAt: '2026-09-27T03:00:00.000Z',
        finishedAt: '2026-09-27T03:00:12.000Z',
        skipped: null,
        initial: {
          campaignId: 'campaign-20260927-001',
          eligible: 2,
          processed: 2,
          sent: 2,
          failed: 0,
          skipped: null,
          promoted: 0,
        },
        followUp: {
          campaignId: 'campaign-20260927-002',
          eligible: 1,
          processed: 1,
          sent: 1,
          failed: 0,
          skipped: null,
          promoted: 0,
        },
        promoted: 0,
      }),
    };
    configValues = {
      'cron.enabled': true,
      'cron.hour': 8,
      'cron.minute': 30,
      'cron.expression': '30 8 * * *',
      'cron.timezone': 'Asia/Kolkata',
      'cron.jobName': DEFAULT_CRON_JOB_NAME,
      'cron.batchLimit': 50,
    };

    service = await buildService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('registration', () => {
    it('registers exactly one job at the configured local time', () => {
      service.onModuleInit();

      expect(registry.addCronJob).toHaveBeenCalledTimes(1);
      const [name, job] = registry.addCronJob.mock.calls[0] as [
        string,
        CronJob,
      ];
      expect(name).toBe(DEFAULT_CRON_JOB_NAME);
      // The job must already be running, otherwise a registered job never
      // fires, and its next tick must be in the configured zone.
      expect(job.nextDate().toMillis()).toBeGreaterThan(Date.now());
      expect(job.nextDate().zoneName).toBe('Asia/Kolkata');
      expect(service.getStatus()).toMatchObject({
        enabled: true,
        registered: true,
        expression: '30 8 * * *',
        timezone: 'Asia/Kolkata',
        batchLimit: 50,
      });
    });

    it('registers nothing at all when CRON_ENABLED is false', () => {
      configValues['cron.enabled'] = false;

      service.onModuleInit();

      expect(registry.addCronJob).not.toHaveBeenCalled();
      expect(service.getStatus()).toMatchObject({
        enabled: false,
        registered: false,
        jobName: null,
        expression: null,
        timezone: null,
      });
    });

    it('removes the job on shutdown', () => {
      service.onModuleInit();

      service.onModuleDestroy();

      expect(registry.deleteCronJob).toHaveBeenCalledWith(
        DEFAULT_CRON_JOB_NAME,
      );
      expect(service.getStatus().registered).toBe(false);
    });
  });

  describe('runNow', () => {
    it('runs the daily cycle with the configured batch limit', async () => {
      const response = await service.runNow();

      expect(campaignService.runDailyCycle).toHaveBeenCalledWith({ limit: 50 });
      expect(response.trigger).toBe('MANUAL');
      expect(response.skipped).toBeNull();
      expect(response.error).toBeNull();
      expect(response.result?.followUp.sent).toBe(1);
    });

    it('records the outcome for GET /scheduler/status', async () => {
      await service.runNow();

      const status = service.getStatus();

      expect(status.lastRunAt).toEqual(expect.any(String));
      expect(status.lastRun?.initial.campaignId).toBe('campaign-20260927-001');
      expect(status.lastError).toBeNull();
    });

    it('reports a skipped cycle instead of pretending it ran', async () => {
      campaignService.runDailyCycle.mockResolvedValue({
        startedAt: '2026-09-27T03:00:00.000Z',
        finishedAt: '2026-09-27T03:00:00.000Z',
        skipped: 'RUN_IN_PROGRESS',
        initial: {
          campaignId: null,
          eligible: 0,
          processed: 0,
          sent: 0,
          failed: 0,
          skipped: 'RUN_IN_PROGRESS',
          promoted: 0,
        },
        followUp: {
          campaignId: null,
          eligible: 0,
          processed: 0,
          sent: 0,
          failed: 0,
          skipped: 'RUN_IN_PROGRESS',
          promoted: 0,
        },
        promoted: 0,
      });

      const response = await service.runNow();

      expect(response.skipped).toBe('RUN_IN_PROGRESS');
    });

    it('rethrows to the caller and records the failure', async () => {
      campaignService.runDailyCycle.mockRejectedValue(
        new Error('sheet unreachable'),
      );

      await expect(service.runNow()).rejects.toThrow('sheet unreachable');

      const status = service.getStatus();

      expect(status.lastError).toBe('sheet unreachable');
      expect(Number.isNaN(Date.parse(status.lastErrorAt as string))).toBe(
        false,
      );
    });

    it('never rejects from the cron tick, which has no caller', async () => {
      campaignService.runDailyCycle.mockRejectedValue(
        new Error('sheet unreachable'),
      );
      const error = jest.spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      );

      // Reaching the private path the CronJob callback uses.
      const response = await (
        service as unknown as {
          runCycle: (trigger: 'CRON') => Promise<unknown>;
        }
      ).runCycle('CRON');

      expect(response).toEqual({
        trigger: 'CRON',
        result: null,
        skipped: null,
        error: 'sheet unreachable',
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('event=scheduler.cycle_failed'),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('trigger=CRON'),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('sheet unreachable'),
      );
      error.mockRestore();
    });
  });
});
