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
    try {
      await this.getTransporter().verify();
    } catch (error) {
      // The SMTP reason (bad credentials, blocked port, TLS required) is the
      // entire point of this check, so it must not be flattened into a 500.
      throw new ServiceUnavailableException(
        `Could not authenticate with ${this.describeHost()}: ${describeReason(error)}`,
      );
    }

    this.logger.log(`SMTP connection verified for ${this.defaultFrom()}`);
  }

  private describeHost(): string {
    const host = this.configService.get<string>('mail.host');
    const port = this.configService.get<number>('mail.port');

    return host
      ? `${host}:${port}`
      : (this.configService.get<string>('mail.service') ?? 'the mail server');
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
      ...this.buildConnection(),
      auth: this.buildAuth(),
    });

    return this.transporter;
  }

  /**
   * Nodemailer's `service` presets carry their own host/port/secure and win over
   * anything passed alongside them, so MAIL_HOST would silently be ignored. An
   * explicit host is therefore always the source of truth, and `service` is only
   * a fallback for when no host is configured.
   */
  private buildConnection(): Record<string, unknown> {
    const host = this.configService.get<string>('mail.host');
    const service = this.configService.get<string>('mail.service');

    if (host) {
      return {
        host,
        port: this.configService.get<number>('mail.port'),
        secure: this.configService.get<boolean>('mail.secure'),
      };
    }

    if (service) return { service };

    throw new ServiceUnavailableException(
      'MAIL_HOST (or MAIL_SERVICE) is not configured — cannot reach a mail server',
    );
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

function describeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/\s+/g, ' ').trim();
}
