export const HEALTH_CHECK_NAMES = {
  GOOGLE_SHEET: 'googleSheet',
  EMAIL: 'email',
} as const;

export type HealthCheckName =
  (typeof HEALTH_CHECK_NAMES)[keyof typeof HEALTH_CHECK_NAMES];

export const HEALTH_STATUS = {
  /** The app answers and every dependency it needs is reachable. */
  UP: 'up',
  /** Reachable, but a dependency the campaign needs is not usable. */
  DEGRADED: 'degraded',
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

export const HEALTH_CHECK_STATUS = {
  UP: 'up',
  DOWN: 'down',
} as const;

export type HealthCheckStatus =
  (typeof HEALTH_CHECK_STATUS)[keyof typeof HEALTH_CHECK_STATUS];
