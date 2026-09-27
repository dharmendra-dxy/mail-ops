import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { CampaignService } from './campaign.service';
import {
  CampaignPreviewResponse,
  CampaignSendResponse,
  ConnectSheetResponse,
  SheetValidationReport,
} from './campaign.types';
import { ConnectSheetDto } from './dto/connect-sheet.dto';
import { PreviewCandidatesDto } from './dto/preview-candidates.dto';
import { SendCampaignDto } from './dto/send-campaign.dto';

@Controller('campaign')
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post('connect-sheet')
  @HttpCode(HttpStatus.OK)
  connectSheet(@Body() dto: ConnectSheetDto): Promise<ConnectSheetResponse> {
    return this.campaignService.connectSheet(dto.spreadsheetUrl, dto.sheetName);
  }

  @Get('validate')
  validateSheet(): Promise<SheetValidationReport> {
    return this.campaignService.validateSheet();
  }

  /** Renders emails without sending them, for review before a real send. */
  @Get('preview')
  preview(
    @Query() dto: PreviewCandidatesDto,
  ): Promise<CampaignPreviewResponse> {
    return this.campaignService.preview(dto);
  }

  /**
   * Dry-run unless `?dryRun=false` is passed explicitly, which is what
   * SEND_DEFAULT_DRY_RUN controls.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  send(@Query() dto: SendCampaignDto): Promise<CampaignSendResponse> {
    return this.campaignService.send(dto);
  }
}
