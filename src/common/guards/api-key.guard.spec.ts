import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

const API_KEY = 'correct-horse-battery-staple';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let security: { enabled: boolean; apiKey: string };
  let handlerMetadata: Record<string, unknown>;

  const buildGuard = (): ApiKeyGuard => {
    const configService = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'security.enabled') return security.enabled;
        if (key === 'security.apiKey') return security.apiKey;
        return fallback;
      },
    } as unknown as ConfigService;

    const reflector = {
      getAllAndOverride: (key: string) =>
        key === IS_PUBLIC_KEY ? handlerMetadata[IS_PUBLIC_KEY] : undefined,
    } as unknown as Reflector;

    return new ApiKeyGuard(configService, reflector);
  };

  const contextFor = (
    headers: Record<string, string | string[]>,
  ): ExecutionContext => {
    const request = { method: 'GET', url: '/api/campaign/status', headers };

    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class TestController {},
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    security = { enabled: true, apiKey: API_KEY };
    handlerMetadata = {};
    guard = buildGuard();
  });

  it('lets every request through when no key is configured', () => {
    security = { enabled: false, apiKey: '' };

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('accepts the key from the dedicated header', () => {
    expect(guard.canActivate(contextFor({ 'x-api-key': API_KEY }))).toBe(true);
  });

  it('accepts the key as a bearer token', () => {
    expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${API_KEY}` })),
    ).toBe(true);
  });

  it('rejects a missing key with a message that names the header', () => {
    expect(() => guard.canActivate(contextFor({}))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextFor({}))).toThrow(/x-api-key/);
  });

  it('rejects a wrong key without revealing whether the length was right', () => {
    expect(() =>
      guard.canActivate(contextFor({ 'x-api-key': 'wrong-key-entirely' })),
    ).toThrow('Invalid API key');

    // A key of a different length must fail with the same message, so timing
    // and text cannot be used to narrow the guess.
    expect(() =>
      guard.canActivate(contextFor({ 'x-api-key': 'short' })),
    ).toThrow('Invalid API key');
  });

  it('rejects a prefix of the real key', () => {
    expect(() =>
      guard.canActivate(contextFor({ 'x-api-key': API_KEY.slice(0, -1) })),
    ).toThrow('Invalid API key');
  });

  it('ignores surrounding whitespace on a valid key', () => {
    expect(
      guard.canActivate(contextFor({ 'x-api-key': `  ${API_KEY}  ` })),
    ).toBe(true);
  });

  it('skips routes marked @Public()', () => {
    handlerMetadata[IS_PUBLIC_KEY] = true;

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });
});
