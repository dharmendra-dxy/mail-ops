import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { CampaignModule } from './modules/campaign';
import { EmailModule } from './modules/email';
import { GoogleSheetModule } from './modules/google-sheet';
import { HealthModule } from './modules/health';
import { SchedulerModule } from './modules/scheduler';
import { APP_GUARD } from '@nestjs/core';
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
    HealthModule,
  ],
  // An `APP_GUARD` rather than a `main.ts` registration so the guard is active
  // in tests and e2e as well, and so a new controller cannot forget it.
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule {}
