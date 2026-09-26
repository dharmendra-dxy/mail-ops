import { Module } from '@nestjs/common';
import { GoogleSheetModule } from '../google-sheet';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';

@Module({
  imports: [GoogleSheetModule],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
