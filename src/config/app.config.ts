import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  /** Upper bound for each dependency probe in `GET /health`. */
  healthCheckTimeoutMs: Number.parseInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS ?? '10000',
    10,
  ),
  /** Retained for `/health` so a stale response is recognisable. */
  startedAt: new Date().toISOString(),
}));
