export const EMAIL_AUTH_TYPE = {
  PASSWORD: 'password',
  OAUTH2: 'oauth2',
} as const;

export type EmailAuthType =
  (typeof EMAIL_AUTH_TYPE)[keyof typeof EMAIL_AUTH_TYPE];

/**
 * Registered `EmailProvider` implementations. Adding SES/Resend in V2 means
 * adding a name here, a class under `providers/`, and one `case` in
 * `email.module.ts` — `CampaignService` and `EmailService` never change.
 */
export const EMAIL_PROVIDER_OPTIONS = {
  NODEMAILER: 'nodemailer',
} as const;

export type EmailProviderName =
  (typeof EMAIL_PROVIDER_OPTIONS)[keyof typeof EMAIL_PROVIDER_OPTIONS];
