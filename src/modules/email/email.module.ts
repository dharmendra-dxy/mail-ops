import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER_OPTIONS } from './email.constant';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EMAIL_PROVIDER } from './providers/email.provider';
import { NodemailerProvider } from './providers/nodemailer.provider';

/**
 * The seam a second provider plugs into (SES, Resend, …).
 *
 * The switch lives here rather than in a factory inside the provider files so
 * that `EMAIL_PROVIDER` resolves to exactly one registered class and an unknown
 * value fails at boot — a missing provider would otherwise only surface as
 * every send failing at once, halfway through a batch.
 */
const emailProvider: Provider = {
  provide: EMAIL_PROVIDER,
  inject: [ConfigService, NodemailerProvider],
  useFactory: (
    configService: ConfigService,
    nodemailerProvider: NodemailerProvider,
  ) => {
    // `mail.config` already defaults this, but a bare `ConfigService` (a unit
    // test, a bare module) must not fail to boot over a missing default.
    const provider = (
      configService.get<string>('mail.provider') ||
      EMAIL_PROVIDER_OPTIONS.NODEMAILER
    ).toLowerCase();

    switch (provider) {
      case EMAIL_PROVIDER_OPTIONS.NODEMAILER:
        return nodemailerProvider;
      default:
        throw new Error(
          `Unsupported MAIL_PROVIDER "${provider}". Use "${EMAIL_PROVIDER_OPTIONS.NODEMAILER}".`,
        );
    }
  },
};

@Module({
  imports: [ConfigModule],
  controllers: [EmailController],
  providers: [NodemailerProvider, emailProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
