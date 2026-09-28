import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CampaignModule } from './modules/campaign';
import { EmailModule } from './modules/email';
import { GoogleSheetModule } from './modules/google-sheet';
import { SchedulerModule } from './modules/scheduler';
import { configurations } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      envFilePath: ['.env.local', '.env'],
    }),
    // Root scheduler: individual jobs are registered by SchedulerService, not
    // by decorators, so CRON_ENABLED=false leaves the registry empty.
    ScheduleModule.forRoot(),
    GoogleSheetModule,
    CampaignModule,
    EmailModule,
    SchedulerModule,
  ],
})
export class AppModule {}
