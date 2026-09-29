import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Shared-secret guard for a personal tool reachable over the network.
 *
 * It is deliberately not JWT/auth machinery: there is exactly one caller, and
 * the only thing standing between a leaked port and 50 real emails is a single
 * secret. When no key is configured the guard is a no-op, so local development
 * needs no setup.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.isEnabled()) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const presented = this.readHeader(request);
    const expected = this.configService.get<string>('security.apiKey', '');

    if (!presented) {
      throw new UnauthorizedException(
        `Missing ${API_KEY_HEADER} header. Send the API key as "${API_KEY_HEADER}: <key>".`,
      );
    }

    if (!this.matches(presented, expected)) {
      // Deliberately identical to a missing key: a distinct message would tell
      // an attacker which half of the guess was right.
      this.logger.warn(
        `Rejected ${request.method} ${request.url} — invalid API key`,
      );
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }

  private isEnabled(): boolean {
    return this.configService.get<boolean>('security.enabled', false) === true;
  }

  /** Accepts the key from either the dedicated header or a bearer token. */
  private readHeader(request: Request): string {
    const direct = firstHeaderValue(request.headers[API_KEY_HEADER]);
    if (direct) return direct.trim();

    const bearer = firstHeaderValue(request.headers.authorization);

    return bearer?.toLowerCase().startsWith('bearer ')
      ? bearer.slice(7).trim()
      : '';
  }

  /**
   * Constant-time comparison, so response timing cannot be used to recover the
   * key one byte at a time. Length is compared first because `timingSafeEqual`
   * throws on a length mismatch.
   */
  private matches(presented: string, expected: string): boolean {
    if (!expected) return false;

    const presentedBuffer = Buffer.from(presented, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (presentedBuffer.length !== expectedBuffer.length) return false;

    return timingSafeEqual(presentedBuffer, expectedBuffer);
  }
}

/** A repeated header is joined by express, so only the first value is a key. */
function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
