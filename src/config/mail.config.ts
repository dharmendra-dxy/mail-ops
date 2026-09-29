import { registerAs } from '@nestjs/config';
import { EMAIL_PROVIDER_OPTIONS } from '../modules/email/email.constant';

export default registerAs('mail', () => ({
  /**
   * Selects the `EmailProvider` implementation. V1 ships only `nodemailer`, but
   * the value is validated at boot so a typo fails loudly instead of silently
   * leaving the app with no way to send.
   */
  provider: (
    process.env.MAIL_PROVIDER ?? EMAIL_PROVIDER_OPTIONS.NODEMAILER
  ).toLowerCase(),
  /** Only used as a fallback when MAIL_HOST is empty (nodemailer presets win). */
  service: process.env.MAIL_SERVICE ?? 'gmail',
  host: process.env.MAIL_HOST ?? '',
  port: Number.parseInt(process.env.MAIL_PORT ?? '587', 10),
  secure: (process.env.MAIL_SECURE ?? 'false') === 'true',
  from: process.env.MAIL_FROM ?? process.env.GMAIL_USER ?? '',
  authType: (process.env.MAIL_AUTH_TYPE ?? 'password').toLowerCase(),
  user: process.env.MAIL_USER ?? process.env.GMAIL_USER ?? '',
  password: process.env.MAIL_PASSWORD ?? '',
  oauth2: {
    clientId:
      process.env.MAIL_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret:
      process.env.MAIL_OAUTH_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET ??
      '',
    refreshToken: process.env.MAIL_OAUTH_REFRESH_TOKEN ?? '',
    accessToken: process.env.MAIL_OAUTH_ACCESS_TOKEN ?? '',
  },
}));
