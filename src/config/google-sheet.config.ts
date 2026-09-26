import { registerAs } from '@nestjs/config';

export const SHEET_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
] as const;

export default registerAs('googleSheet', () => {
  const driver = (
    process.env.GOOGLE_SHEET_DRIVER ?? 'apps_script'
  ).toLowerCase();

  return {
    driver,
    appsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL ?? '',
    defaultSpreadsheetId: process.env.GOOGLE_SPREADSHEET_ID ?? '',
    defaultSheetName: process.env.SHEET_NAME ?? 'Candidates',
    requestTimeoutMs: Number.parseInt(
      process.env.GOOGLE_SHEET_TIMEOUT_MS ?? '15000',
      10,
    ),
    serviceAccount: {
      clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '',
      // Kept on a single line in .env; the literal "\n" escapes are expanded here.
      privateKey: (
        process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? ''
      ).replace(/\\n/g, '\n'),
      scopes: [...SHEET_SCOPES],
    },
  };
});
