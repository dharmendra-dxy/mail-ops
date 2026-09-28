import appConfig from './app.config';
import campaignConfig from './campaign.config';
import cronConfig from './cron.config';
import googleSheetConfig from './google-sheet.config';
import mailConfig from './mail.config';

export interface AppConfig {
  app: ReturnType<typeof appConfig>;
  campaign: ReturnType<typeof campaignConfig>;
  cron: ReturnType<typeof cronConfig>;
  googleSheet: ReturnType<typeof googleSheetConfig>;
  mail: ReturnType<typeof mailConfig>;
}

export const configurations = [
  appConfig,
  campaignConfig,
  cronConfig,
  googleSheetConfig,
  mailConfig,
];

export { appConfig, campaignConfig, cronConfig, googleSheetConfig, mailConfig };
