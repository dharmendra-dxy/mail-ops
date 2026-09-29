import type { SendEmailOptions, SendEmailResult } from '../email.types';

/**
 * Sending is behind an interface so the campaign layer stays provider-agnostic
 * (Phase 2 uses nodemailer; SES/Resend can be added later without touching it).
 *
 * Contract a second implementation must honour:
 * - `send` resolves with a provider `messageId`, which is written to the sheet
 *   as the durable proof of delivery and is threaded into follow-up replies.
 * - `send` rejects with an `Error` whose message is classified by
 *   `classifyEmailError`; wrap transport errors so their cause is in the
 *   message, otherwise a retryable failure is treated as permanent.
 * - `verify` rejects with a `ServiceUnavailableException` carrying the reason a
 *   human needs; it backs both `POST /email/verify` and `GET /health`.
 * - Implementations are stateless with respect to a batch: the campaign service
 *   owns the state machine, not the provider.
 */
export interface EmailProvider {
  readonly name: string;
  send(options: SendEmailOptions): Promise<SendEmailResult>;
  verify(): Promise<void>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
