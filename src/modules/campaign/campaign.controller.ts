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
  CampaignRunResponse,
  CampaignPreviewResponse,
  CampaignStatusResponse,
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
   * Live counts by status, plus whether a campaign currently holds the
   * single-run lock. Read this to watch a background run from Phase 3.
   */
  @Get('status')
  status(): Promise<CampaignStatusResponse> {
    return this.campaignService.getStatus();
  }

  /**
   * Dry-run unless `?dryRun=false` is passed explicitly, which is what
   * SEND_DEFAULT_DRY_RUN controls. A dry run answers with the rendered emails;
   * a real send answers `STARTED` immediately and runs in the background.
   * A second concurrent run is rejected with 409.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  send(@Query() dto: SendCampaignDto): Promise<CampaignRunResponse> {
    return this.campaignService.send(dto);
  }
}
