# MailOps — Development Guide 4 (Phase 5)

What changed in **Phase 5 — Hardening, Observability & Polish**, and how to
operate the tool without reading its code.

Companions: `prd.md` (product), `plan.md` (phases), `architecture.md` (code
conventions), [`guide.md`](./guide.md) (Phases 1–2), [`guide-2.md`](./guide-2.md)
(Phase 3) and [`guide-3.md`](./guide-3.md) (Phase 4).

**Status: all five phases complete.** This is the last phase; the README is
the operator's document and this one explains the code behind it.

---

## 1. What Phase 5 delivers

| Plan item | Delivered |
|---|---|
| Structured logging per candidate/attempt | `event=<name> key=value …` via `common/logger/log-event.util.ts`; every campaign, follow-up, retry and cron line is now greppable |
| `GET /health` confirming Sheets and Gmail connectivity | `src/modules/health/` — concurrent probes, `200` up / `503` degraded, never throws |
| Graceful shutdown for an in-flight batch | `CampaignService.onApplicationShutdown` drains the detached run, bounded by `SHUTDOWN_DRAIN_TIMEOUT_MS` |
| Final review of the `EmailProvider` abstraction | Contract documented; `MAIL_PROVIDER` selects an implementation via a factory; an unknown value refuses to boot |
| API-level guard (simple API key header) | `common/guards/api-key.guard.ts`, registered as an `APP_GUARD`, `API_KEY` config |
| README covering columns, `.env`, dry-run vs real send, cron/follow-ups | Complete, plus the new sections |
| Test pass over the four scenarios | Existing suites extended; new suites for the guard, health, provider wiring, log format and shutdown drain |

The plan's exit criterion — handed to "future you" with just the README and
`.env` — is met. Everything below is detail you only need when changing the
code.

---

## 2. Files added / changed

| File | Change |
|---|---|
| `common/logger/log-event.util.ts` | **new** — `formatLogEvent(event, fields)`; skips null/undefined, quotes values with spaces |
| `common/logger/log-event.util.spec.ts` | **new** — 5 tests |
| `common/decorators/public.decorator.ts` | **new** — `@Public()`, the opt-out from the guard |
| `common/guards/api-key.guard.ts` | **new** — constant-time key check, `x-api-key` or bearer |
| `common/guards/api-key.guard.spec.ts` | **new** — 8 tests |
| `config/security.config.ts` | **new** — `API_KEY` / `API_KEY_ENABLED`, fails fast on the lockout combination |
| `config/security.config.spec.ts` | **new** — 6 tests |
| `config/app.config.ts` | +`healthCheckTimeoutMs`, +`startedAt` |
| `config/campaign.config.ts` | +`shutdownDrainTimeoutMs` |
| `config/mail.config.ts` | +`provider` (`MAIL_PROVIDER`) |
| `config/index.ts` | registers `securityConfig` |
| `modules/health/` | **new** — `health.constant.ts`, `health.types.ts`, `health.service.ts`, `health.controller.ts`, `health.module.ts`, `index.ts` |
| `modules/health/health.service.spec.ts` | **new** — 7 tests |
| `modules/google-sheet/google-sheet.service.ts` | +`checkConnectivity()` (tab list only, no data read) |
| `modules/email/email.constant.ts` | +`EMAIL_PROVIDER_OPTIONS` |
| `modules/email/email.module.ts` | provider is now resolved by a factory on `MAIL_PROVIDER` |
| `modules/email/email.service.ts` | `verify()` now also reports the provider name |
| `modules/email/email.types.ts` | +`provider` on `EmailVerificationResult` |
| `modules/email/email.module.spec.ts` | **new** — 3 tests: default binding, casing, unknown value refuses to boot |
| `modules/email/providers/email.provider.ts` | the contract a second implementation must honour, written down |
| `modules/campaign/campaign.service.ts` | `OnApplicationShutdown` + drain; every log line structured; `send` refuses while draining |
| `modules/campaign/campaign.constant.ts` | +`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS` |
| `modules/scheduler/scheduler.service.ts` | structured logs |
| `app.module.ts` | +`HealthModule`, +`APP_GUARD` |
| `main.ts` | startup log states whether a key is required |
| `test/health.e2e-spec.ts` | **new** — 3 tests: 200 report, 503 with the failing dependency named, API open without a key |
| `test/api-key.e2e-spec.ts` | **new** — 5 tests: missing/wrong/right key, bearer, `/health` exempt |
| `.env.example`, `README.md` | API access, health, shutdown, logging, `MAIL_PROVIDER`, new config rows |

`GoogleSheetRepository`, both sheet drivers, the `Candidate` entity,
`TemplateService` and every template are **untouched**.

---

## 3. Structured logging

The problem Phase 5 solves: a 60-row batch produces ~180 log lines, and the
useful question is rarely "what happened?" but "which rows failed, and why?".

Every line in the campaign and scheduler services now leads with a stable
event name:

```text
event=candidate.failed row=9 to=hr@initech.com kind=initial campaignId=campaign-20260927-001 attempt=3 maxAttempts=3 reason="503 service unavailable"
```

`formatLogEvent` is 20 lines and lives in `common/logger/`, because two modules
need it. It drops `null`/`undefined` fields rather than printing them, and
quotes any value containing a space so a line stays parseable.

| Event | Level | Meaning |
|---|---|---|
| `campaign.started` / `campaign.finished` / `campaign.aborted` | log / error | One batch, with `sent`/`failed` counts |
| `campaign.aborted_before_sending` | error | The batch died before the row loop, e.g. the sheet write for `PROCESSING` failed |
| `candidate.sent` | log | `row`, `to`, `kind`, `campaignId`, `attempt`, `maxAttempts`, `messageId` |
| `candidate.failed` | error | Same fields plus `reason` |
| `candidate.template_failed` | error | The row failed **before** `PROCESSING` — nothing was in flight |
| `send.attempt.retrying` / `.permanent_failure` / `.budget_exhausted` | warn | The three ways an attempt ends, so retry behaviour is visible per row |
| `batch.recovered_stale` / `batch.skipped_exhausted` / `batch.empty` | warn/debug | Row-set decisions, with the row numbers |
| `cycle.started` / `cycle.finished` / `cycle.skipped` | log/warn | The daily cycle, including `durationMs` |
| `followup.scheduled` / `.recovered_stale` / `.skipped_undated` / `.skipped_failed` | log/warn | Why a follow-up did or did not go out |
| `dryrun.rendered` / `dryrun.body` | log / debug | Subject always; body only at `debug` |
| `cron.registered` / `cron.disabled` / `cron.stopped` | log | Schedule lifecycle |
| `scheduler.cycle` / `scheduler.cycle_failed` | log/error | One line per tick |
| `shutdown.drain.started` / `.completed` / `.timed_out` | log | Graceful shutdown |

`kind=initial` vs `kind=follow-up` is the field to filter on when a row was
touched twice.

Full bodies moved to `debug` deliberately: at `log` level a 50-row dry run
would print 50 complete emails into the terminal scrollback.

---

## 4. `GET /health`

```text
HealthController → HealthService ─┬→ GoogleSheetService.checkConnectivity()
                                 └→ EmailService.verify()
```

```json
{
  "status": "up",
  "checkedAt": "2026-09-27T02:31:04.882Z",
  "uptimeSeconds": 8134,
  "checks": [
    { "name": "googleSheet", "status": "up", "durationMs": 214,
      "detail": "1 tab(s) reachable, \"Candidates\" present via apps_script" },
    { "name": "email", "status": "up", "durationMs": 388,
      "detail": "SMTP credentials accepted for me@gmail.com via smtp.gmail.com" }
  ]
}
```

Design decisions worth knowing:

- **Probes are concurrent and never throw.** A health endpoint that 500s tells
  a monitor that *something* broke; a per-dependency report names it. Each
  probe converts any failure into `status: down` with the reason in `detail`.
- **`200` when both are up, `503` otherwise.** The status is set with
  `@Res({ passthrough: true })` rather than by throwing, because the global
  exception filter would flatten the report into a message string and lose the
  detail that makes the endpoint useful.
- **Each probe is bounded** by `HEALTH_CHECK_TIMEOUT_MS`. A driver or SMTP
  server that accepts the connection and then hangs would otherwise hang the
  endpoint, and a monitor cannot distinguish "slow" from "gone".
- **The sheet probe lists tabs; it does not read rows.** 60 rows cost an extra
  API call and prove nothing more about reachability. The `detail` string still
  reports whether the configured tab is actually present, because a wrong
  `SHEET_NAME` fails every campaign while the sheet itself is perfectly healthy.
- **`emailService.verify()` is reused rather than reimplemented.** It is the
  same credential check as `POST /email/verify`, and it lives behind
  `EmailProvider`, so a non-SMTP provider brings its own probe.
- **Multi-line provider errors are collapsed** to one line, because SMTP errors
  arrive as stacks and a single sheet of a log should stay readable.
- **It is `@Public()`.** A monitor that cannot authenticate cannot ask whether
  the thing is alive. The body reveals tab names, a driver name and a mail host
  — no credentials, no spreadsheet id, no row data.

---

## 5. Graceful shutdown

`POST /campaign/send` runs the batch **detached**: a 50-row batch takes about
`50 × EMAIL_DELAY_MS`, and holding the HTTP request open for that would time
out. Detached is also what made shutdown unsafe — a `Ctrl-C` during a batch
killed the process between `PROCESSING` being written and `SENT` being written,
leaving a row in `PROCESSING` that only stale-`PROCESSING` recovery (30 minutes
later) could pick up, with the mail possibly already delivered.

```ts
// spawnRun registers the promise; nothing awaits it during a normal run.
this.activeRun = this.spawnRun(options, { campaignId, eligible });
void this.activeRun;
```

```ts
async onApplicationShutdown(signal?: string): Promise<void> {
  this.isDraining = true;
  const run = this.activeRun;
  if (!run) return;

  const timeoutMs = /* SHUTDOWN_DRAIN_TIMEOUT_MS, default 30s */;
  const drained = await this.waitFor(run, timeoutMs);
  // logs shutdown.drain.completed or shutdown.drain.timed_out
}
```

| Concern | Decision |
|---|---|
| Only the *current* run is awaited | A restart does not resume a half-finished batch; rows not yet reached stay `PENDING` and go out on the next tick, which is already the designed behaviour |
| The wait is bounded | A hung provider must not block shutdown forever. On timeout the row stays `PROCESSING` and stale recovery still applies — the drain is an optimisation, not a correctness requirement |
| A failed run counts as settled | There is nothing left to wait for; the batch already recorded its failures in the sheet |
| New campaigns are refused with 409 | Accepting a run that is about to be killed would leave exactly the state the drain exists to prevent |
| `app.enableShutdownHooks()` is required | It was already on; without it Nest never calls the hook |

The cron is stopped first (`SchedulerService.onModuleDestroy`), so no new tick
can arrive while the drain is in progress. Ordering is Nest's, not ours:
`onModuleDestroy` → `beforeApplicationShutdown` → connections close.

Tests: a row released *after* the drain starts still reaches `SENT`; a hung
provider lets the drain expire; a send attempted after shutdown is refused.

---

## 6. The `EmailProvider` seam

Phase 2 left the interface in place; Phase 5 made the seam explicit and
verifiable.

```text
CampaignService → EmailService → EMAIL_PROVIDER → (factory on MAIL_PROVIDER) → NodemailerProvider
```

- `CampaignService` injects `EmailService` and never sees a provider. This is
  the property that matters: adding SES in V2 must not touch the campaign layer,
  and that is now structurally impossible rather than merely intended.
- `EmailModule` resolves the provider through a factory on `MAIL_PROVIDER`, so
  a second implementation is a new class plus one `case`. An **unknown value
  refuses to boot** — the alternative is discovering at 08:00 that nothing can
  be sent, mid-batch.
- `providers/email.provider.ts` documents the contract a new provider must
  honour: return a `messageId` (it is the sheet's durable proof of delivery and
  threads follow-up replies), reject with a message `classifyEmailError` can
  read (an opaque transport error is treated as permanent and never retried),
  and make `verify()` fail with a reason a human can act on.
- `EmailService.verify()` now reports `provider`, so `POST /email/verify` and
  `GET /health` say *which* implementation answered.

Tests: default binding, case-insensitive selection, and the unknown-value
refusal.

---

## 7. API key guard

```text
APP_GUARD → ApiKeyGuard → Reflector (@Public?) → ConfigService (security.*)
```

- **Registered as an `APP_GUARD`,** not in `main.ts`. A new controller is
  therefore protected by default; forgetting to opt in is impossible, and the
  e2e suites exercise the same wiring the process uses.
- **Disabled when no `API_KEY` is set,** so local development needs no setup.
  Setting `API_KEY` alone enables it — forgetting `API_KEY_ENABLED` must not
  silently expose the API.
- **`API_KEY_ENABLED=true` with no key refuses to boot.** Otherwise the
  operator locks themselves out of their own tool with no way back in but an
  editor.
- **Accepted as `x-api-key: <key>` or `Authorization: Bearer <key>`.** The
  bearer form is not extra surface area to manage, just a header a `curl` user
  already knows.
- **Constant-time comparison,** after an explicit length check, so timing
  cannot recover the key a byte at a time.
- **A wrong key and a missing key get the same message.** A distinct message
  would tell an attacker which half of the guess was right.
- **Only `GET /health` is `@Public()`.** See section 4.

Scope, stated plainly: this protects the *API*. The Apps Script bridge is
deployed with "Anyone" access by design (it is how the app reads a private
sheet without Google credentials), so the sheet itself is guarded by Google
account permissions, not by this key.

---

## 8. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `API_KEY` | – | Shared secret. Setting it enables the guard |
| `API_KEY_ENABLED` | derived from `API_KEY` | Force the guard on or off; `true` with no key refuses to boot |
| `HEALTH_CHECK_TIMEOUT_MS` | `10000` | Per-probe timeout in `GET /health` |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `30000` | How long shutdown waits for the in-flight row |
| `MAIL_PROVIDER` | `nodemailer` | Registered `EmailProvider`; unknown value refuses to boot |

Fail-fast behaviour matches `cron.config.ts`: a typo that would silently
disable a safeguard is a startup error, not a runtime surprise.

```text
API_KEY_ENABLED=true (no API_KEY)  →  API_KEY must be set when API_KEY_ENABLED is true…
MAIL_PROVIDER=resend               →  Unsupported MAIL_PROVIDER "resend". Use "nodemailer".
```

---

## 9. Operating it

```bash
# 0. Is everything the app depends on actually reachable?
curl -s http://localhost:3000/api/health | jq
# → status "up", or 503 naming the failing dependency

# 1. Prove the API key is enforced (if you set one).
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/campaign/status
# → 401
curl -s -H "x-api-key: $API_KEY" http://localhost:3000/api/campaign/status | jq .counts

# 2. Watch a real batch by its event stream rather than by polling.
npm run start:dev 2>&1 | grep -E 'event=(candidate|campaign|send)\.'
grep 'event=candidate.failed' → exactly the rows to look at
grep 'event=send.attempt.retrying' → rows fighting a flaky provider

# 3. Restart safely mid-batch. The current row finishes first.
#    (Ctrl-C, or: docker stop)
```

A degraded `/health` before a campaign is the cheapest possible check: a wrong
`SHEET_NAME` or a revoked App Password is visible without sending anything.

---

## 10. Tests

| Suite | Tests | Covers |
|---|---|---|
| `common/logger/log-event.util.spec.ts` | 5 | event prefix, null/undefined dropped, quoting, escaping |
| `common/guards/api-key.guard.spec.ts` | 8 | disabled no-op, both header forms, missing/wrong/prefix rejection, whitespace, `@Public()` |
| `config/security.config.spec.ts` | 6 | default off, key implies enabled, explicit disable, trimming, both fail-fast cases |
| `modules/health/health.service.spec.ts` | 7 | both up, each dependency failing alone, multi-line errors, timeout, never throws, missing tab reported |
| `modules/email/email.module.spec.ts` | 3 | default binding, case-insensitivity, unknown provider refuses to boot |
| `modules/campaign/campaign.service.spec.ts` | 53 (was 49) | +4: drain waits for the in-flight row, no run drains instantly, drain times out, send refused while draining |
| `modules/scheduler/scheduler.service.spec.ts` | 8 | unchanged behaviour, log assertions moved to the structured format |
| `test/health.e2e-spec.ts` | 3 | `200` report, `503` with the reason, API open without a key |
| `test/api-key.e2e-spec.ts` | 5 | `401` missing/wrong, header + bearer accepted, send endpoint protected, `/health` exempt |
| `test/campaign.e2e-spec.ts` | 14 | unchanged |

```bash
npm test          # 144 unit tests
npm run test:e2e  # 22 e2e tests
```

The four scenarios `plan.md` asks for are covered by existing suites: crash
recovery (`batch.recovered_stale` + stale `PROCESSING` tests), duplicate
prevention (the 409 e2e test and the eligibility filters), invalid-row
validation (`validateSheet` tests), follow-up timing (`follow_up_days=0`,
promotion, and no auto-retry of `FAILED`).

---

## 11. Deliberate decisions

| Decision | Reason |
|---|---|
| `GET /health` is `@Public()` | A monitor that cannot authenticate cannot tell whether the service is alive |
| Health returns `503` instead of throwing | The exception filter would replace the per-dependency report with a one-line message |
| Sheet probe lists tabs, not rows | Reachability is the question; reading 60 rows costs an API call and proves nothing more |
| Probes run concurrently and never reject | One slow or broken dependency must not hide the other's status |
| Drain waits for the current run only, with a timeout | A restart should not resume a half-finished batch; rows stay `PENDING` by design |
| `send` is refused while draining | Accepting a run about to be killed creates the state the drain prevents |
| Guard is an `APP_GUARD` | New controllers are protected by default rather than by remembering `main.ts` |
| Missing and wrong keys give the same 401 | A different message is a free oracle for an attacker |
| Guard is off when no key is set | Local development should not require ceremony |
| `API_KEY_ENABLED=true` without a key fails the boot | A locked-out operator cannot diagnose their own lockout |
| Unknown `MAIL_PROVIDER` fails the boot | Discovering at send time that no provider exists is worse |
| Log bodies moved to `debug` | A 50-row dry run at `log` level buries everything else |
| `campaign_id` and `kind` on every candidate line | A row can be touched twice (initial, then follow-up); the log has to say which |
| `EmailService.verify()` extended, not duplicated | `/health` and `/email/verify` must not drift apart |

---

## 12. Known limitations (V1, carried forward)

- **In-memory single-run lock.** Two instances would defeat both the lock and
  the cron. V1 assumes one process; `CRON_JOB_NAME` is the seam.
- **No delivery or open tracking.** A `SENT` row means the provider accepted
  the message, not that it arrived. Webhooks are V2.
- **No unsubscribe workflow.** `follow_up_enabled=NO` is the manual opt-out.
  A real campaign at volume needs more than that.
- **Rate safety is a fixed delay, not adaptive.** `EMAIL_DELAY_MS` between
  sends; a provider 429 still burns the retry budget per row.
- **`lastRun` is in memory.** Gone on restart. The sheet is the durable record.
- **The API key does not protect the sheet**, only the API. See section 7.
- **Health probes are shallow.** They prove reachability and credentials, not
  that a campaign would succeed end to end. `GET /campaign/preview` and a
  one-row `?limit=1&dryRun=false` remain the real proof.
- **Templates live in code.** Changing copy is a deploy, not a config change.

## 13. Where V2 starts

The seams Phase 5 left in place, in the order a V2 would use them:

1. **A second provider** — new class + one `case` in `email.module.ts`.
2. **A real queue** — `runDailyCycle` is already a single entry point returning
   a result object, so BullMQ replaces the detached promise, not the service.
3. **Distributed locking** — `tryAcquireRun` / `releaseRun` are the only two
   methods to swap for a Redis lock; the batch logic never asks whether it is
   the only instance.
4. **Delivery webhooks** — `message_id` is already stored per row, which is
   what a webhook would be matched on.
