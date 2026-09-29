import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email';
import { GoogleSheetService } from '../google-sheet';
import {
  HEALTH_CHECK_NAMES,
  HEALTH_CHECK_STATUS,
  HEALTH_STATUS,
  type HealthCheckName,
} from './health.constant';
import type { HealthCheckResult, HealthReport } from './health.types';

const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly googleSheetService: GoogleSheetService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Probes both external dependencies the campaign cannot run without.
   *
   * Both probes run concurrently and neither may reject: a health endpoint that
   * throws tells a monitor nothing except that *something* broke, whereas a
   * per-dependency report names it.
   */
  async check(): Promise<HealthReport> {
    const [sheet, email] = await Promise.all([
      this.probe(HEALTH_CHECK_NAMES.GOOGLE_SHEET, () =>
        this.checkGoogleSheet(),
      ),
      this.probe(HEALTH_CHECK_NAMES.EMAIL, () => this.checkEmail()),
    ]);

    const checks = [sheet, email];
    const isUp = checks.every(
      (check) => check.status === HEALTH_CHECK_STATUS.UP,
    );

    return {
      status: isUp ? HEALTH_STATUS.UP : HEALTH_STATUS.DEGRADED,
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private async checkGoogleSheet(): Promise<string> {
    const result = await this.googleSheetService.checkConnectivity();

    return `${result.sheetNames.length} tab(s) reachable, "${result.sheetName}" ${
      result.sheetNames.includes(result.sheetName) ? 'present' : 'missing'
    } via ${result.driver}`;
  }

  private async checkEmail(): Promise<string> {
    const { host, user } = await this.emailService.verify();

    return `SMTP credentials accepted for ${user} via ${host}`;
  }

  /**
   * Runs one probe under a timeout and converts any failure — thrown, rejected
   * or hung — into a `down` result. The sheet cell a human reads is the `error`
   * field, and provider errors routinely contain addresses and hosts, so the
   * message is collapsed to a single line.
   */
  private async probe(
    name: HealthCheckName,
    run: () => Promise<string>,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();

    try {
      const detail = await this.withTimeout(run());

      return {
        name,
        status: HEALTH_CHECK_STATUS.UP,
        durationMs: Date.now() - startedAt,
        detail,
      };
    } catch (error) {
      const detail = describeReason(error);
      this.logger.warn(`Health check "${name}" failed: ${detail}`);

      return {
        name,
        status: HEALTH_CHECK_STATUS.DOWN,
        durationMs: Date.now() - startedAt,
        detail,
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs =
      this.configService.get<number>('app.healthCheckTimeoutMs') ??
      DEFAULT_CHECK_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `no response within ${timeoutMs}ms (check the network or the driver's timeout)`,
          ),
        );
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

function describeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/\s+/g, ' ').trim();
}
