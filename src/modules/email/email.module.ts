import { Module, Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EMAIL_PROVIDER } from './providers/email.provider';
import { NodemailerProvider } from './providers/nodemailer.provider';

const emailProvider: Provider = {
  provide: EMAIL_PROVIDER,
  useExisting: NodemailerProvider,
};

@Module({
  imports: [ConfigModule],
  controllers: [EmailController],
  providers: [NodemailerProvider, emailProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
