import { Module } from '@nestjs/common';
import { CampaignModule } from '../campaign';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';

/**
 * `ScheduleModule.forRoot()` is registered in `AppModule`, not here: it owns
 * the root scheduler and must be instantiated exactly once per process.
 */
@Module({
  imports: [CampaignModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
