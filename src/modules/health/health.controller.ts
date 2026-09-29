import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { HEALTH_STATUS } from './health.constant';
import { HealthService } from './health.service';
import type { HealthReport } from './health.types';

/**
 * Readiness probe for the two external dependencies a campaign needs.
 *
 * Answers 503 when either is down so a monitor can act on it, and stays
 * `@Public()` so the API key guard does not stand between a monitor and the
 * answer. The body reports tab counts and a mail host, never a credential.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  async check(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthReport> {
    const report = await this.healthService.check();

    // Set here rather than with `@HttpCode` so the full report survives in the
    // body on both paths; the exception filter would flatten it into a message.
    response.status(report.status === HEALTH_STATUS.UP ? 200 : 503);

    return report;
  }
}
