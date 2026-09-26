import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER } from './providers/email.provider';
import type { EmailProvider } from './providers/email.provider';
import {
  EmailVerificationResult,
  SendEmailOptions,
  SendEmailResult,
} from './email.types';

/** Single entry point the rest of the app uses to send mail. */
@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly configService: ConfigService,
  ) {}

  send(options: SendEmailOptions): Promise<SendEmailResult> {
    return this.provider.send(options);
  }

  async verify(): Promise<EmailVerificationResult> {
    await this.provider.verify();

    return {
      verified: true,
      host: this.configService.get<string>('mail.host', ''),
      user: this.configService.get<string>('mail.user', ''),
    };
  }
}
