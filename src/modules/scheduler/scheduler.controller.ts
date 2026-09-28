import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import type { SchedulerRunResponse, SchedulerStatus } from './scheduler.types';

@Controller('scheduler')
export class SchedulerController {
  constructor(private readonly schedulerService: SchedulerService) {}

  /**
   * Whether a job is actually registered, and what the last cycle did. With
   * `CRON_ENABLED=false` this reports `registered: false` and a null schedule,
   * which is the honest answer — the app really is not going to wake up.
   */
  @Get('status')
  status(): SchedulerStatus {
    return this.schedulerService.getStatus();
  }

  /**
   * Runs the daily cycle now: due initial emails, then due follow-ups. The
   * same lock applies, so a tick that arrives mid-run is reported as skipped
   * rather than double-sending anything.
   */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  run(): Promise<SchedulerRunResponse> {
    return this.schedulerService.runNow();
  }
}
