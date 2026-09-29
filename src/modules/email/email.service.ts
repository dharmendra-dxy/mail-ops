import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER } from './providers/email.provider';
import type { EmailProvider } from './providers/email.provider';
import {
  EmailVerificationResult,
  SendEmailOptions,
  SendEmailResult,
} from './email.types';

/**
 * Single entry point the rest of the app uses to send mail.
 *
 * Everything provider-specific — transport, auth, message ids — stays behind
 * `EmailProvider`, so this class is the only thing the campaign layer depends
 * on. `CampaignService` never imports a provider.
 */
@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly configService: ConfigService,
  ) {}

  send(options: SendEmailOptions): Promise<SendEmailResult> {
    return this.provider.send(options);
  }

  /**
   * Probes the provider's credentials. Its `verify()` is already provider-
   * specific (SMTP handshake today, an API call for SES), which is why the
   * abstraction carries it rather than the service guessing.
   */
  async verify(): Promise<EmailVerificationResult> {
    await this.provider.verify();

    return {
      verified: true,
      provider: this.provider.name,
      host: this.configService.get<string>('mail.host', ''),
      user: this.configService.get<string>('mail.user', ''),
    };
  }
}
