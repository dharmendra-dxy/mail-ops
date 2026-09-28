import cronConfig from './cron.config';

/**
 * The factory reads `process.env` on every call, so each test sets the exact
 * variables it cares about and restores them afterwards.
 */
describe('cronConfig', () => {
  const KEYS = [
    'CRON_ENABLED',
    'CRON_HOUR',
    'CRON_MINUTE',
    'CRON_TIMEZONE',
    'CRON_JOB_NAME',
    'CRON_BATCH_LIMIT',
  ];
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

  it('defaults to disabled so a fresh checkout never mails anyone', () => {
    withEnv({});

    const config = cronConfig();

    expect(config.enabled).toBe(false);
    expect(config.hour).toBe(8);
    expect(config.minute).toBe(0);
    expect(config.timezone).toBe('Asia/Kolkata');
    expect(config.expression).toBe('0 8 * * *');
    expect(config.batchLimit).toBe(50);
  });

  it('builds the daily expression from hour and minute', () => {
    withEnv({ CRON_ENABLED: 'true', CRON_HOUR: '19', CRON_MINUTE: '45' });

    const config = cronConfig();

    expect(config.enabled).toBe(true);
    expect(config.expression).toBe('45 19 * * *');
  });

  it('accepts the usual truthy and falsy spellings', () => {
    withEnv({ CRON_ENABLED: 'yes' });
    expect(cronConfig().enabled).toBe(true);

    withEnv({ CRON_ENABLED: '0' });
    expect(cronConfig().enabled).toBe(false);
  });

  it('refuses to boot on an out-of-range hour or minute', () => {
    // A schedule that never fires looks exactly like a working one, so a typo
    // must fail loudly at startup.
    withEnv({ CRON_ENABLED: 'true', CRON_HOUR: '25' });
    expect(() => cronConfig()).toThrow(/CRON_HOUR must be an integer/);

    withEnv({ CRON_ENABLED: 'true', CRON_MINUTE: '99' });
    expect(() => cronConfig()).toThrow(/CRON_MINUTE must be an integer/);

    withEnv({ CRON_ENABLED: 'true', CRON_MINUTE: 'half past' });
    expect(() => cronConfig()).toThrow(/CRON_MINUTE must be an integer/);
  });

  it('refuses to boot on an invalid time zone', () => {
    withEnv({ CRON_ENABLED: 'true', CRON_TIMEZONE: 'Kolkata-ish' });

    expect(() => cronConfig()).toThrow(/not a valid IANA time zone/);
  });

  it('refuses to boot on an unrecognised CRON_ENABLED value', () => {
    withEnv({ CRON_ENABLED: 'maybe' });

    expect(() => cronConfig()).toThrow(/CRON_ENABLED must be one of/);
  });
});
