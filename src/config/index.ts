import appConfig from './app.config';
import campaignConfig from './campaign.config';
import googleSheetConfig from './google-sheet.config';
import mailConfig from './mail.config';

export interface AppConfig {
  app: ReturnType<typeof appConfig>;
  campaign: ReturnType<typeof campaignConfig>;
  googleSheet: ReturnType<typeof googleSheetConfig>;
  mail: ReturnType<typeof mailConfig>;
}

export const configurations = [
  appConfig,
  campaignConfig,
  googleSheetConfig,
  mailConfig,
];

export { appConfig, campaignConfig, googleSheetConfig, mailConfig };
