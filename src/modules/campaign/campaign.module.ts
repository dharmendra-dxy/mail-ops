import { Module } from '@nestjs/common';
import { EmailModule } from '../email';
import { GoogleSheetModule } from '../google-sheet';
import { TemplateModule } from '../template';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';

@Module({
  imports: [GoogleSheetModule, TemplateModule, EmailModule],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
