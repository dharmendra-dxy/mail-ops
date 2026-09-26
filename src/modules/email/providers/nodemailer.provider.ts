import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import { EMAIL_AUTH_TYPE } from '../email.constant';
import { SendEmailOptions, SendEmailResult } from '../email.types';
import { EmailProvider } from './email.provider';

@Injectable()
export class NodemailerProvider implements EmailProvider {
  readonly name = 'nodemailer';

  private readonly logger = new Logger(NodemailerProvider.name);

  private transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {}

  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    const info = await this.getTransporter().sendMail({
      from: options.from ?? this.defaultFrom(),
      to: options.to,
      subject: options.subject,
      text: options.body,
      html: options.html,
      replyTo: options.replyTo,
      inReplyTo: options.inReplyTo,
    });

    return {
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      response: info.response ?? '',
    };
  }

  async verify(): Promise<void> {
    await this.getTransporter().verify();
    this.logger.log(`SMTP connection verified for ${this.defaultFrom()}`);
  }

  private defaultFrom(): string {
    const from = this.configService.get<string>('mail.from');
    if (!from) {
      throw new ServiceUnavailableException(
        'MAIL_FROM (or GMAIL_USER) is not configured — cannot determine the sender address',
      );
    }

    return from;
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      service: this.configService.get<string>('mail.service'),
      host: this.configService.get<string>('mail.host'),
      port: this.configService.get<number>('mail.port'),
      secure: this.configService.get<boolean>('mail.secure'),
      auth: this.buildAuth(),
    });

    return this.transporter;
  }

  private buildAuth(): Record<string, unknown> {
    const user = this.configService.get<string>('mail.user');
    const authType = this.configService.get<string>('mail.authType');

    if (!user) {
      throw new ServiceUnavailableException(
        'MAIL_USER (or GMAIL_USER) is not configured — cannot authenticate with the mail server',
      );
    }

    if (authType === EMAIL_AUTH_TYPE.OAUTH2) {
      return {
        type: 'OAuth2',
        user,
        clientId: this.configService.get<string>('mail.oauth2.clientId'),
        clientSecret: this.configService.get<string>(
          'mail.oauth2.clientSecret',
        ),
        refreshToken: this.configService.get<string>(
          'mail.oauth2.refreshToken',
        ),
        accessToken:
          this.configService.get<string>('mail.oauth2.accessToken') ||
          undefined,
      };
    }

    return {
      user,
      pass: this.configService.get<string>('mail.password'),
    };
  }
}
