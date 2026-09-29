import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailModule } from './email.module';
import { EMAIL_PROVIDER } from './providers/email.provider';
import type { EmailProvider } from './providers/email.provider';

const buildModule = async (provider: string | undefined) => {
  const configService = {
    get: (key: string, fallback?: unknown) =>
      key === 'mail.provider' ? provider : fallback,
  } as unknown as ConfigService;

  const module = await Test.createTestingModule({
    imports: [EmailModule],
  })
    .overrideProvider(ConfigService)
    .useValue(configService)
    .compile();

  return module.get<EmailProvider>(EMAIL_PROVIDER);
};

describe('EmailModule provider wiring', () => {
  it('binds nodemailer by default', async () => {
    await expect(buildModule(undefined)).resolves.toMatchObject({
      name: 'nodemailer',
    });
  });

  it('binds the configured provider, whatever its casing', async () => {
    await expect(buildModule('Nodemailer')).resolves.toMatchObject({
      name: 'nodemailer',
    });
  });

  it('refuses to boot on an unknown provider instead of sending nothing', async () => {
    // A missing provider would otherwise only surface halfway through a batch.
    await expect(buildModule('resend')).rejects.toThrow(
      /Unsupported MAIL_PROVIDER "resend"/,
    );
  });
});
