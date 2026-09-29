# MailOps — Development Guide 3 (Phase 4)

What changed in **Phase 4 — Scheduling & Follow-ups**, and how to operate it
safely.

Companions: `prd.md` (product), `plan.md` (phases), `architecture.md` (code
conventions), [`guide.md`](./guide.md) (Phases 1–2) and
[`guide-2.md`](./guide-2.md) (Phase 3) and [`guide-4.md`](./guide-4.md) (Phase 5).

**Status: all five phases complete.** Phase 5 is in
[`guide-4.md`](./guide-4.md).

---

## 1. What Phase 4 delivers

| Plan item | Delivered |
|---|---|
| `cron.config.ts` parses `CRON_ENABLED` / `CRON_HOUR` / `CRON_MINUTE` / `CRON_TIMEZONE` | `src/config/cron.config.ts`, validated at boot |
| `SchedulerService` with `SchedulerRegistry` + `CronJob`, dynamic registration in `onModuleInit` | `src/modules/scheduler/scheduler.service.ts` |
| `CRON_ENABLED=false` registers **no job at all** | no `CronJob` object is constructed, so the registry stays empty |
| One daily job calls the campaign service | `runDailyCycle()` — due initial emails, then due follow-ups, under one lock |
| Follow-up fields on the candidate model | already mapped and validated in Phases 1–2; Phase 4 acts on them |
| `CampaignService.processFollowUps()` | real implementation, own state machine and own columns |
| Stale-`PROCESSING` recovery | already built for initial emails; extended to follow-ups |
| Single daily entry point running both halves in sequence | `CampaignService.runDailyCycle()` |

The exit criteria from `plan.md` are met:

- `CRON_ENABLED=true` with the clock a minute away sends due initial emails and
  due follow-ups with no API call — the job is registered at boot and the tick
  is the only trigger.
- `CRON_ENABLED=false` registers nothing; `GET /api/scheduler/status` reports
  `registered: false` and a `null` schedule.
- A row flipped to `follow_up_enabled=YES` with `follow_up_days=0` gets its
  follow-up on the very next tick, because the due time is recomputed from
  `sent_at` on every run rather than stored.

---

## 2. Files added / changed

| File | Change |
|---|---|
| `config/cron.config.ts` | **new** — `CRON_*` parsing, range checks, IANA time-zone check, derived cron expression |
| `config/cron.config.spec.ts` | **new** — 6 tests: defaults, expression building, and the fail-fast cases |
| `config/index.ts` | registers `cronConfig` in `AppConfig` and `configurations` |
| `modules/scheduler/scheduler.constant.ts` | **new** — defaults, job name, hour/minute bounds |
| `modules/scheduler/scheduler.types.ts` | **new** — `SchedulerStatus`, `SchedulerRunResponse` |
| `modules/scheduler/scheduler.service.ts` | **new** — dynamic registration, cycle trigger, last-run record, shutdown |
| `modules/scheduler/scheduler.controller.ts` | **new** — `GET /scheduler/status`, `POST /scheduler/run` |
| `modules/scheduler/scheduler.module.ts` | **new** — imports `CampaignModule`, exports `SchedulerService` |
| `modules/scheduler/scheduler.service.spec.ts` | **new** — 8 tests: registration, disabled path, shutdown, run reporting, error handling |
| `modules/campaign/campaign.service.ts` | `runDailyCycle`, `processScheduledEmails`, `processFollowUps`, follow-up state machine, shared `sendWithRetry`, `tryAcquireRun` |
| `modules/campaign/campaign.types.ts` | `BatchRunResult`, `DailyCycleResult`, `ScheduledRunOptions`, `SKIP_REASON` |
| `modules/campaign/campaign.constant.ts` | follow-up status literals |
| `modules/campaign/campaign.utils.ts` | `followUpDueAt`, `isFollowUpDue`, `isStaleFollowUpProcessing`, `MILLISECONDS_PER_DAY` |
| `modules/campaign/campaign.service.spec.ts` | +16 tests: follow-ups and the daily cycle (49 in the file) |
| `app.module.ts` | `ScheduleModule.forRoot()` + `SchedulerModule` |
| `package.json` | added `@nestjs/schedule` |
| `.env.example`, `README.md` | cron block, scheduler/follow-up docs, per-variable config table |

`GoogleSheetService`, `GoogleSheetRepository`, both sheet drivers, the
`Candidate` entity and `TemplateService` are **untouched** — every follow-up
field Phase 4 needed already existed on the row model.

---

## 3. How the daily run is wired

```text
CRON_ENABLED=true
      │
      ▼
SchedulerService.onModuleInit()          ← one CronJob, "min hour * * *", CRON_TIMEZONE
      │
      ▼ (once a day, or POST /scheduler/run)
SchedulerService.runCycle(trigger)
      │  { limit: CRON_BATCH_LIMIT }
      ▼
CampaignService.runDailyCycle()          ← takes the single-run lock once
      │
      ├── runInitialBatch()   → filterEligible → executeCampaign
      └── runFollowUpBatch()  → promoteScheduledFollowUps → filterDueFollowUps
                                → executeFollowUpCampaign
      │
      ▼
BatchRunResult { eligible, processed, sent, failed, skipped, promoted }
```

`runDailyCycle` is the only cron entry point, and it is the only place where
both halves share one lock. That matters: without it, the initial half would
release the lock while settling rows and the follow-up half could start on top
of it.

### 3.1 Registration, not a decorator

There is no `@Cron()` anywhere. `onModuleInit` builds a `CronJob` and hands it
to `SchedulerRegistry.addCronJob` **only** when `cron.enabled` is true:

```ts
if (!settings.enabled) {
  this.logger.log('Cron is disabled (CRON_ENABLED=false) — no job registered. …');
  return;
}
```

So "cron is off" means no timer exists, not a timer that wakes up and returns.
`GET /api/scheduler/status` reports that honestly: `registered: false`,
`expression: null`, `timezone: null`.

Two details worth knowing:

- `CronJob`'s sixth constructor argument is a *context*, not a name. The job
  name is the **registry key**, which is why `addCronJob(jobName, job)` matters
  for shutdown and for `doesExist`.
- `onModuleDestroy` stops the timer *and* deletes it from the registry, guarded
  by `doesExist` — the registry throws on an unknown name, and another shutdown
  hook may have cleared it first.

### 3.2 The cron callback cannot reject

`runCycle` is async and cron does not await it, so a rejection would surface as
an unhandled rejection and take the process down on a single sheet outage:

- **`CRON` trigger** → the error is logged, recorded in
  `lastError`/`lastErrorAt`, and swallowed.
- **`MANUAL` trigger** → the error is rethrown, because there the HTTP caller
  deserves to see it.

Both paths are covered by tests.

---

## 4. Follow-ups

### 4.1 When one is due

```text
status = SENT
  AND follow_up_enabled = YES
  AND sent_at is readable
  AND follow_up_days is a number in 0…365
  AND sent_at + follow_up_days ≤ now
  AND follow_up_status ∈ { NOT_SCHEDULED, SCHEDULED, stale PROCESSING }
  AND the row passes sheet validation
```

The due time is **computed, never stored**. `followUpDueAt(candidate)` returns
`sent_at + follow_up_days × 24h`, and `isFollowUpDue` compares it to now. Two
consequences worth stating out loud:

- Editing `follow_up_days` in the sheet takes effect on the next run; there is
  no stored schedule to invalidate.
- `follow_up_days` is a 24-hour window, not a calendar day. A row sent at 23:00
  with `follow_up_days=3` becomes due at 23:00 three days later.

### 4.2 The state machine

```text
   NOT_SCHEDULED ──(cycle sees sent_at)──► SCHEDULED
                                              │
                                              ▼
                                       PROCESSING   ← the pre-send lock
                                     ok ────┴──── fail
                                    ▼                  ▼
                                  SENT               FAILED  (manual reset only)
                        follow_up_sent_at      follow_up_status
                        follow_up_message_id   error
```

- **Promotion is its own write.** `NOT_SCHEDULED → SCHEDULED` happens on the
  first cycle that sees a readable `sent_at`, whether or not the follow-up is due
  today. The sheet therefore shows the queue *before* anything fires, and the
  count is returned as `promoted`.
- **`PROCESSING` is written before the provider call**, exactly as for initial
  emails, and it reuses `processing_started_at` (see section 6).
- **A follow-up never touches the initial record.** It writes
  `follow_up_status`, `follow_up_sent_at`, `follow_up_message_id` and `error` —
  never `status`, `sent_at`, `message_id` or `attempts`. The one column it does
  share is `error`, which the PRD gives a single definition: a successful
  follow-up clears it, so a row that once failed its *initial* send shows an
  empty `error` after a successful follow-up. The per-run reason is in the logs
  and in `follow_up_status`.
- It is threaded under the original mail: `inReplyTo: candidate.messageId`.
  Phase 3 already passed that value; this is where it becomes meaningful.

### 4.3 What is deliberately *not* automatic

| Case | Behaviour | Why |
|---|---|---|
| `follow_up_status = SENT` | never re-sent | the whole point of the column |
| `follow_up_status = FAILED` | never re-sent automatically; logged with a "set it back to `SCHEDULED`" hint | an unbounded daily retry loop is exactly what gets an outreach domain throttled |
| unreadable `sent_at` or `follow_up_days` | skipped, row numbers logged | silently treating it as "not due" would hide a data error |
| invalid row (bad email/role) | skipped | the follow-up filter must not become a second, quieter way to mail invalid rows |
| `PROCESSING` inside the stale threshold | left alone | something may genuinely be in flight |

---

## 5. The single-run lock, extended

Phase 3 had one boolean and an `acquireRun()` that threw `409`. Phase 4 adds a
non-throwing sibling, because a cron tick must not fail a request:

```ts
private tryAcquireRun(): boolean   // false if a run is in flight
private acquireRun(): void         // throws ConflictException if tryAcquireRun() is false
```

| Caller | Lock behaviour |
|---|---|
| `POST /campaign/send` | `acquireRun()` → **409** if busy (unchanged) |
| `runDailyCycle()` | `tryAcquireRun()` → returns `skipped: 'RUN_IN_PROGRESS'`, nothing sent |
| `processScheduledEmails()` / `processFollowUps()` | same, per batch |

A tick that lands mid-campaign is therefore a no-op that says so, in the logs
and in the API response. The next day it runs normally.

Lock ownership was also tightened while refactoring: the row loops no longer
release the lock themselves (only the outermost owner does, in a `finally`), and
`POST /campaign/send` hands its already-resolved batch to the background run
instead of making it re-read the sheet — one fewer Sheet call per campaign, and
no chance of sending a different row set than the response counted.

---

## 6. `processing_started_at` is shared

The PRD defines one `processing_started_at` column, so the follow-up lock
writes to the same cell:

| Row state | Column | Written by |
|---|---|---|
| initial in flight | `status = PROCESSING` | `markProcessing` |
| initial settled | `status = SENT`/`FAILED` (timestamp left as an audit trail) | `processCandidate` |
| follow-up in flight | `follow_up_status = PROCESSING` | `markFollowUpProcessing` |
| follow-up settled | `follow_up_status = SENT`/`FAILED` | `processFollowUpCandidate` |

This is safe because the two lifecycles cannot overlap on a row: a follow-up
only exists once `status = SENT`. The cost is that the column no longer
identifies *which* send was in flight — the row's `follow_up_status` does that.

Staleness uses the same rule as Phase 3, over the same threshold
(`STALE_PROCESSING_THRESHOLD_MINUTES`, default 30): a `PROCESSING` row older
than the threshold, or with no readable timestamp, is treated as a crash
leftover and re-eligible.

---

## 7. Retries, shared

`sendWithRetry()` is now the single place a provider is called from, used by both
paths, so classification and the retry budget cannot drift apart. It **never
writes to the sheet** — the caller owns the state transition. That separation is
what keeps "the mail is out but the settle write failed" distinguishable from a
send failure, and it is why the abort-on-failed-write rule from Phase 3 still
holds.

One asymmetry, on purpose: the retry budget for an initial email starts at
`candidate.attempts` (the sheet's own `attempts` column), while a follow-up
starts at 0. `attempts` is the *initial* email's budget; overwriting it with
follow-up counts would erase the record of how hard the first send worked. A
follow-up's attempt count is per-run and appears in the logs and in the error
text.

---

## 8. API

| Endpoint | Purpose |
|---|---|
| `GET /api/scheduler/status` | `enabled`, `registered`, `jobName`, `expression`, `timezone`, `batchLimit`, `lastRunAt`, `lastRun`, `lastErrorAt`, `lastError` |
| `POST /api/scheduler/run` | runs the cycle now, returns `{ trigger: 'MANUAL', result, skipped, error }` |

`GET /campaign/status` is unchanged and still the place to watch row-level
progress; `followUp` counts were already there in Phase 3 and now move.

`POST /campaign/send` is unchanged **except** that it never sends follow-ups.
Follow-ups are driven by the cycle, so a manual batch cannot double-contact
someone in one sitting.

### `POST /api/scheduler/run` response

```json
{
  "trigger": "MANUAL",
  "skipped": null,
  "error": null,
  "result": {
    "startedAt": "2026-09-27T03:00:00.000Z",
    "finishedAt": "2026-09-27T03:01:47.000Z",
    "skipped": null,
    "promoted": 3,
    "initial": {
      "campaignId": "campaign-20260927-001",
      "eligible": 12, "processed": 12, "sent": 11, "failed": 1, "skipped": null, "promoted": 0
    },
    "followUp": {
      "campaignId": "campaign-20260927-002",
      "eligible": 4, "processed": 4, "sent": 4, "failed": 0, "skipped": null, "promoted": 3
    }
  }
}
```

Each half gets its own `campaign_id`. The follow-up half re-reads the sheet
after the initial half has written, so it numbers itself after the id the
initial half just stamped — that is what produces `-001` then `-002` above.

---

## 9. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CRON_ENABLED` | `false` | `false` registers no job at all |
| `CRON_HOUR` | `8` | local hour of the daily run (0–23) |
| `CRON_MINUTE` | `0` | local minute (0–59) |
| `CRON_TIMEZONE` | `Asia/Kolkata` | IANA zone the schedule is timed in |
| `CRON_JOB_NAME` | `mailops-daily-campaign` | registry key of the job |
| `CRON_BATCH_LIMIT` | `50` | cap per run, applied to initial emails and follow-ups **separately** |
| `STALE_PROCESSING_THRESHOLD_MINUTES` | `30` | shared by both state machines |

`cron.config.ts` **fails the boot** on an out-of-range hour/minute, an
unrecognised `CRON_ENABLED` value, or an invalid time zone:

```text
CRON_TIMEZONE must be …  →  CRON_TIMEZONE "Kolkata-ish" is not a valid IANA time zone (e.g. Asia/Kolkata)
```

That is intentional. A mistyped schedule that silently never fires is
indistinguishable from a working one, and for a tool whose whole job is to send
mail at 08:00, silence is the worst possible failure mode.

Note that `CRON_BATCH_LIMIT` is per half: a day with 60 due initial emails and
5 due follow-ups at a limit of 50 sends 50 + 5, not 50 + 0.

---

## 10. Operating it

```bash
# 0. Confirm what the app thinks its schedule is.
curl -s http://localhost:3000/api/scheduler/status | jq

# 1. Prove the pipeline on one person (Phase 1–3 habit, still the right one).
curl -X POST 'http://localhost:3000/api/campaign/send?dryRun=false&limit=1'
curl -s http://localhost:3000/api/campaign/status | jq

# 2. Turn cron on in .env, restart, and confirm it registered.
#    CRON_ENABLED=true
curl -s http://localhost:3000/api/scheduler/status | jq '.enabled, .registered, .expression, .timezone'
# → true, true, "0 8 * * *", "Asia/Kolkata"

# 3. Do not wait until 08:00 to find out. Trigger the cycle.
curl -X POST http://localhost:3000/api/scheduler/run | jq '.result | {initial, followUp}'

# 4. Make one follow-up due without waiting days:
#    set follow_up_enabled=YES and follow_up_days=0 on a row that is already SENT.
curl -X POST http://localhost:3000/api/scheduler/run | jq '.result.followUp'

# 5. Watch the last cycle result later.
curl -s http://localhost:3000/api/scheduler/status | jq '.lastRun, .lastError'
```

Two things to expect in the sheet after a cycle:

- `follow_up_status` flips `NOT_SCHEDULED → SCHEDULED` for every opted-in row
  that has a `sent_at`, whether or not it is due.
- `campaign_id` on a follow-up row is overwritten with the follow-up campaign's
  id. The initial send's id is therefore only preserved until the first follow-up
  runs — read the sheet's `sent_at`/`message_id` if you need the original run.

---

## 11. Tests

| Suite | Tests | Covers |
|---|---|---|
| `config/cron.config.spec.ts` | 6 | defaults, expression building, and every fail-fast case |
| `modules/scheduler/scheduler.service.spec.ts` | 8 | registers one job at the configured local time; registers nothing when disabled; stops and deletes on shutdown; passes the batch limit; records `lastRun`/`lastError`; never rejects from the cron path |
| `modules/campaign/campaign.service.spec.ts` | 49 (was 33) | follow-up promotion, due-time arithmetic, `follow_up_days=0`, opt-in gate, no double-send, no auto-retry of `FAILED`, stale vs fresh follow-up `PROCESSING`, unreadable timing, retry then settle, `FAILED` write, validation skip, batch limit; cycle ordering, per-half campaign ids, empty-sheet no-op, `RUN_IN_PROGRESS` skip, per-half limits |
| `test/campaign.e2e-spec.ts` | 14 | unchanged — the app still boots with `ScheduleModule` wired in |

```bash
npm test          # 110 unit tests
npm run test:e2e  # 14 e2e tests
```

---

## 12. Deliberate decisions

| Decision | Reason |
|---|---|
| No `@Cron()` decorator; registration in `onModuleInit` | The only way to guarantee `CRON_ENABLED=false` leaves the registry empty, rather than a job that fires and no-ops |
| Boot-time validation of the cron fields | A schedule that never fires is indistinguishable from a working one |
| One lock for the whole cycle | Otherwise a follow-up could start while initial rows are still settling |
| Follow-ups are not reachable from `POST /campaign/send` | One place decides when to contact someone; a manual batch must not double-contact |
| Due time computed, not stored | Editing `follow_up_days` takes effect immediately, with nothing to migrate |
| A `FAILED` follow-up is never auto-retried | Requires a human to opt back in; protects the sending domain |
| `processing_started_at` shared between the two state machines | Matches the PRD column list; the row's `follow_up_status` disambiguates which send was in flight |
| Follow-up attempts are per-run, not in `attempts` | `attempts` is the initial email's budget and must not be overwritten |
| A cron failure is swallowed, a manual failure is rethrown | An unhandled rejection in a timer callback would kill the process; an HTTP caller should see its own 500 |
| `promoted` is a separate count from `sent` | "Queued" and "mailed" are different facts, and conflating them hides a stuck row |
| `GET /campaign/preview?type=follow_up` still filters to `PENDING` rows | Follow-up templates render from the same variables as initial ones, so a `PENDING` row is representative. Still true in Phase 5: preview shows what a template renders, not what is due |

---

## 13. Known limitations

- **In-memory lock only.** Two instances would defeat both the run lock and the
  cron. V1 assumes one process; `CRON_JOB_NAME` is the seam to change if that
  ever stops being true.
- **`lastRun` is in memory.** It disappears on restart, which is fine — the sheet
  is the durable record. `GET /health` reports uptime but no run history, for
  the same reason.
- **A cycle that crashes mid-way is not resumable within the same tick.** Rows
  already sent stay sent; rows not yet reached stay `PENDING` and go out on the
  next tick.
- **The API key protects the API, not the data.** The Apps Script bridge is
  deployed with "Anyone" access, so the sheet itself is guarded by Google, not
  by `API_KEY`.

Closed in Phase 5 (see [`guide-4.md`](./guide-4.md)): the missing graceful
drain, `GET /health`, the API-key guard and structured logging.
