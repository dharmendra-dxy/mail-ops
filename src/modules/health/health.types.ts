import type {
  HealthCheckName,
  HealthCheckStatus,
  HealthStatus,
} from './health.constant';

export interface HealthCheckResult {
  name: HealthCheckName;
  status: HealthCheckStatus;
  /** How long the probe took; useful when a driver or SMTP is timing out. */
  durationMs: number;
  /** Human-readable detail. Never contains credentials. */
  detail: string;
}

export interface HealthReport {
  status: HealthStatus;
  /** ISO timestamp of the probe, so a stale response is recognisable. */
  checkedAt: string;
  uptimeSeconds: number;
  checks: HealthCheckResult[];
}
