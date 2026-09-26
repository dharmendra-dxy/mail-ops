import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppsScriptSheetDriver } from './drivers/apps-script.driver';
import { ServiceAccountSheetDriver } from './drivers/service-account.driver';
import { GoogleSheetRepository } from './google-sheet.repository';
import { GoogleSheetService } from './google-sheet.service';
import { SHEET_DRIVER, SHEET_DRIVER_OPTIONS } from './google-sheet.constant';

const sheetDriverProvider: Provider = {
  provide: SHEET_DRIVER,
  inject: [ConfigService, AppsScriptSheetDriver, ServiceAccountSheetDriver],
  useFactory: (
    configService: ConfigService,
    appsScriptDriver: AppsScriptSheetDriver,
    serviceAccountDriver: ServiceAccountSheetDriver,
  ) => {
    const driver = (
      configService.get<string>('googleSheet.driver') ?? ''
    ).toLowerCase();

    switch (driver) {
      case SHEET_DRIVER_OPTIONS.SERVICE_ACCOUNT:
        return serviceAccountDriver;
      case SHEET_DRIVER_OPTIONS.APPS_SCRIPT:
        return appsScriptDriver;
      default:
        throw new Error(
          `Unsupported GOOGLE_SHEET_DRIVER "${driver}". Use "${SHEET_DRIVER_OPTIONS.APPS_SCRIPT}" or "${SHEET_DRIVER_OPTIONS.SERVICE_ACCOUNT}".`,
        );
    }
  },
};

@Module({
  imports: [ConfigModule],
  controllers: [],
  providers: [
    AppsScriptSheetDriver,
    ServiceAccountSheetDriver,
    sheetDriverProvider,
    GoogleSheetRepository,
    GoogleSheetService,
  ],
  exports: [GoogleSheetService, GoogleSheetRepository],
})
export class GoogleSheetModule {}
