import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { ConnectSheetResponse, SheetValidationReport } from './campaign.types';
import { ConnectSheetDto } from './dto/connect-sheet.dto';

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
}
