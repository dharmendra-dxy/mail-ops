import { registerAs } from '@nestjs/config';

export default registerAs('campaign', () => ({
  emailDelayMs: Number.parseInt(process.env.EMAIL_DELAY_MS ?? '2000', 10),
  emailMaxRetries: Number.parseInt(process.env.EMAIL_MAX_RETRIES ?? '2', 10),
  /** Fallback for POST /campaign/send when ?dryRun is not supplied. */
  sendDefaultDryRun: (process.env.SEND_DEFAULT_DRY_RUN ?? 'true') === 'true',
  staleProcessingThresholdMinutes: Number.parseInt(
    process.env.STALE_PROCESSING_THRESHOLD_MINUTES ?? '30',
    10,
  ),
  /**
   * How long shutdown waits for the row that is currently in flight before it
   * gives up and lets the process exit. A row interrupted mid-send is still
   * recoverable via stale-PROCESSING recovery, so this only bounds the wait.
   */
  shutdownDrainTimeoutMs: Number.parseInt(
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? '30000',
    10,
  ),
}));
