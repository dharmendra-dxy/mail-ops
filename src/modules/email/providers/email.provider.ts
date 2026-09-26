import { SendEmailOptions, SendEmailResult } from '../email.types';

/**
 * Sending is behind an interface so the campaign layer stays provider-agnostic
 * (Phase 2 uses nodemailer; SES/Resend can be added later without touching it).
 */
export interface EmailProvider {
  readonly name: string;
  send(options: SendEmailOptions): Promise<SendEmailResult>;
  verify(): Promise<void>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
