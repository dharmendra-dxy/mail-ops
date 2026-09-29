import { Module } from '@nestjs/common';
import { CampaignModule } from '../campaign';
import { EmailModule } from '../email';
import { GoogleSheetModule } from '../google-sheet';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [GoogleSheetModule, EmailModule, CampaignModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
