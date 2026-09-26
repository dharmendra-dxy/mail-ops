export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** Used to thread a follow-up under the original outreach email. */
  inReplyTo?: string;
}

export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface EmailVerificationResult {
  verified: boolean;
  host: string;
  user: string;
}
