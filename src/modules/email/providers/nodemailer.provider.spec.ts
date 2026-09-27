import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AddressInfo } from 'net';
import { NodemailerProvider } from './nodemailer.provider';

interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
}

/**
 * Minimal shape of the smtp-server test double. Declared here rather than
 * pulling in a typings package for a test-only dependency.
 */
interface SmtpTestServer {
  server: { address(): AddressInfo | string | null };
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback: () => void): unknown;
}

interface SmtpTestServerOptions {
  disabledCommands?: string[];
  onAuth?: (
    auth: { username: string },
    session: unknown,
    callback: (error: Error | null, response?: { user: string }) => void,
  ) => void;
  onData?: (
    stream: { on(event: string, listener: (chunk: string) => void): void },
    session: {
      envelope: {
        mailFrom: { address: string };
        rcptTo: { address: string }[];
      };
    },
    callback: () => void,
  ) => void;
}

interface SmtpTestServerCtor {
  new (options: SmtpTestServerOptions): SmtpTestServer;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const smtpServerModule = require('smtp-server') as SmtpTestServerCtor & {
  SMTPServer: SmtpTestServerCtor;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const SMTPServer = smtpServerModule.SMTPServer ?? smtpServerModule;

describe('NodemailerProvider', () => {
  let smtp: SmtpTestServer;
  let smtpPort: number;
  let received: CapturedMail[];

  const buildProvider = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      'mail.host': '127.0.0.1',
      'mail.port': smtpPort,
      'mail.secure': false,
      'mail.service': 'gmail',
      'mail.from': 'tester@example.com',
      'mail.user': 'tester@example.com',
      'mail.password': 'app-password',
      'mail.authType': 'password',
      'mail.oauth2.clientId': '',
      'mail.oauth2.clientSecret': '',
      'mail.oauth2.refreshToken': '',
      'mail.oauth2.accessToken': '',
      ...overrides,
    };

    const configService = {
      get: (key: string, fallback?: unknown) =>
        key in values ? values[key] : fallback,
    } as unknown as ConfigService;

    return new NodemailerProvider(configService);
  };

  beforeAll(async () => {
    received = [];
    smtp = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      onAuth: (auth, _session, callback) =>
        callback(null, { user: auth.username }),
      onData: (stream, session, callback) => {
        let raw = '';
        stream.on('data', (chunk) => (raw += chunk));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
          });
          callback();
        });
      },
    });

    await new Promise<void>((resolve) => {
      smtp.listen(0, '127.0.0.1', () => {
        smtpPort = (smtp.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
  });

  it('sends through the configured host even when a service preset is set', async () => {
    // Regression: nodemailer's `service` presets carry their own host/port and
    // used to silently win over MAIL_HOST, making it impossible to point the
    // transport anywhere else.
    const provider = buildProvider();

    const result = await provider.send({
      to: 'asha@example.com',
      subject: 'Frontend role at Acme',
      body: 'Hi Asha,',
    });

    expect(result.messageId).toEqual(expect.stringContaining('@'));
    expect(result.accepted).toEqual(['asha@example.com']);
    expect(received).toHaveLength(1);
    expect(received[0].to).toEqual(['asha@example.com']);
    expect(received[0].from).toBe('tester@example.com');
    expect(received[0].raw).toContain('Subject: Frontend role at Acme');
    expect(received[0].raw).toContain('Hi Asha,');
  });

  it('honours an explicit from address per message', async () => {
    await buildProvider().send({
      to: 'hr@globex.com',
      subject: 'Hello',
      body: 'Body',
      from: 'recruiter@me.com',
    });

    expect(received[0].from).toBe('recruiter@me.com');
  });

  it('uses the sender from config when none is passed', async () => {
    await buildProvider().send({
      to: 'hr@globex.com',
      subject: 'Hello',
      body: 'Body',
    });

    expect(received[0].from).toBe('tester@example.com');
  });

  it('verifies a working transport', async () => {
    await expect(buildProvider().verify()).resolves.toBeUndefined();
  });

  it('surfaces the SMTP reason when verification fails', async () => {
    const provider = buildProvider({ 'mail.port': 1 });

    await expect(provider.verify()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(provider.verify()).rejects.toThrow(/127\.0\.0\.1:1/);
  });

  it('falls back to the service preset when no host is configured', async () => {
    // Nothing local to talk to, so this asserts the configuration error rather
    // than a delivery: a preset-only setup must not silently pick a bad host.
    const provider = buildProvider({ 'mail.host': '' });

    await expect(provider.verify()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('requires a sender address', async () => {
    const provider = buildProvider({ 'mail.from': '', 'mail.user': 'x@y.com' });

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/MAIL_FROM/);
  });

  it('requires a mail user', async () => {
    const provider = buildProvider({ 'mail.user': '', 'mail.password': 'x' });

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/MAIL_USER/);
  });

  it('threads a follow-up with inReplyTo', async () => {
    await buildProvider().send({
      to: 'asha@example.com',
      subject: 'Re: Frontend role at Acme',
      body: 'Circling back.',
      inReplyTo: '<original-message-id@example.com>',
    });

    expect(received[0].raw).toContain(
      'In-Reply-To: <original-message-id@example.com>',
    );
  });
});
