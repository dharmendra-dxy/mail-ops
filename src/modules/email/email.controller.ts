import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailVerificationResult } from './email.types';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /** Confirms the SMTP/OAuth2 credentials work before a real campaign is run. */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(): Promise<EmailVerificationResult> {
    return this.emailService.verify();
  }
}
