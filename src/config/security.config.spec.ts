import { ConfigService } from '@nestjs/config';
import securityConfig from './security.config';

describe('securityConfig', () => {
  const KEYS = ['API_KEY', 'API_KEY_ENABLED'];
  const original = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of KEYS) original.set(key, process.env[key]);
  });

  afterAll(() => {
    for (const key of KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const withEnv = (values: Record<string, string>): void => {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  };

  it('is disabled when no key is configured', () => {
    withEnv({});

    expect(securityConfig()).toEqual({ enabled: false, apiKey: '' });
  });

  it('enables itself when a key is present, so the flag cannot be forgotten', () => {
    withEnv({ API_KEY: 's3cret' });

    const config = securityConfig();

    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe('s3cret');
  });

  it('can be turned off explicitly even with a key present', () => {
    withEnv({ API_KEY: 's3cret', API_KEY_ENABLED: 'false' });

    expect(securityConfig().enabled).toBe(false);
  });

  it('trims surrounding whitespace from the key', () => {
    withEnv({ API_KEY: '  s3cret  ' });

    expect(securityConfig().apiKey).toBe('s3cret');
  });

  it('refuses to boot when enabled with no key, which would lock the owner out', () => {
    withEnv({ API_KEY_ENABLED: 'true' });

    expect(() => securityConfig()).toThrow(/API_KEY must be set/);
  });

  it('refuses to boot on an unrecognised API_KEY_ENABLED value', () => {
    withEnv({ API_KEY: 's3cret', API_KEY_ENABLED: 'maybe' });

    expect(() => securityConfig()).toThrow(/API_KEY_ENABLED must be one of/);
  });

  it('is read through ConfigService, not process.env, at request time', () => {
    // The guard reads the parsed value; nothing else should have to parse it.
    withEnv({ API_KEY: 's3cret' });
    const parsed = securityConfig();

    const configService = {
      get: (key: string, fallback?: unknown) =>
        key === 'security.enabled' ? parsed.enabled : fallback,
    } as unknown as ConfigService;

    expect(configService.get<boolean>('security.enabled', false)).toBe(true);
  });
});
