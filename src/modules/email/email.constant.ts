export const EMAIL_AUTH_TYPE = {
  PASSWORD: 'password',
  OAUTH2: 'oauth2',
} as const;

export type EmailAuthType =
  (typeof EMAIL_AUTH_TYPE)[keyof typeof EMAIL_AUTH_TYPE];
