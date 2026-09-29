# MailOps — Development Guide 2 (Phase 3)

What changed in **Phase 3 — Campaign Orchestration, State Machine & Failure
Handling**, and how to operate it safely.

Companions: `prd.md` (product), `plan.md` (phases), `architecture.md` (code
conventions) and [`guide.md`](./guide.md) (Phase 1–2 background). This document
supersedes the "What Phase 3 will add (not built yet)" section of `guide.md`.

**Status: all five phases complete.** This document covers Phase 3; see
[`guide-3.md`](./guide-3.md) for Phase 4 (cron + follow-ups) and
[`guide-4.md`](./guide-4.md) for Phase 5 (hardening).

---

## 1. What Phase 3 delivers

| Plan item | Delivered |
|---|---|
| `PENDING → PROCESSING → SENT/FAILED` per row | `CampaignService.processCandidate` — `PROCESSING` is written **before** the provider is called |
| Sequential sends with `EMAIL_DELAY_MS` | unchanged, but the loop is now a background run |
| In-memory `isCampaignRunning` lock | `acquireRun()` / `releaseRun()`; a second run gets **409 Conflict** |
| Retryable vs non-retryable classification | `classifyEmailError()` in `campaign.utils.ts`, honouring `EMAIL_MAX_RETRIES` |
| `campaign-YYYYMMDD-NNN` stamped on every row | `nextCampaignId()`, derived from the ids already on the sheet |
| `POST /campaign/send` returns immediately | real sends answer `{ status: 'STARTED', campaignId, total }` |
| `GET /campaign/status` | new endpoint, live counts + follow-up counts + lock state |
| Per-row isolation | one row's failure can never abort the batch (covered by a test) |

The exit criterion from `plan.md` — *"a full batch can be sent with one failing
row not blocking the rest; re-triggering `send` while one is running is
rejected; killing the process mid-batch and restarting does not double-send
already-`SENT` rows"* — is now enforced by code and covered by tests.

---

## 2. The state machine

```text
                    ┌──────────────────────────────┐
                    │  PENDING (attempts < budget) │
                    └──────────────┬───────────────┘
                                   │  write: status, processing_started_at, campaign_id
                                   ▼
                            ┌─────────────┐
                            │ PROCESSING  │   ← the pre-send lock
                            └──────┬──────┘
                     send ok      │        send failed
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
       ┌────────────┐                        retryable & budget left?
       │    SENT    │                                 │            │
       │ sent_at    │                       yes ─────┘            └── no ──┐
       │ message_id │                          │                            │
       │ attempts++ │                    wait EMAIL_DELAY_MS                 │
       └────────────┘                          │  (retry in place)            │
                                                 └──────────────┐              │
                                                                ▼              ▼
                                                         (PROCESSING)      ┌─────────┐
                                                                          │ FAILED  │
                                                                          │ error   │
                                                                          │ attempts│
                                                                          └─────────┘
```

Two deliberate properties:

- **`PROCESSING` is written first.** If the process dies between the write and
  the provider call, the sheet still says `PROCESSING` with a timestamp, and
  Phase 3's stale-recovery rule (section 6) picks it up. Without it, a crash
  would leave the row `PENDING` and the next run would send it again.
- **A template failure never enters `PROCESSING`.** Rendering happens before
  the lock is taken, so a broken template cannot leave rows in flight.

And one thing the diagram hides: the write that settles `SENT` sits **outside**
the send's `try/catch`. Once the provider has accepted the mail it is gone, so a
failed state write must abort the run — never re-enter the loop and send it
twice. The row simply stays `PROCESSING` and stale recovery deals with it.

---

## 3. Files added / changed

| File | Change |
|---|---|
| `campaign/campaign.constant.ts` | **new** — status literals, campaign-id format, retryable/non-retryable error patterns, config fallbacks |
| `campaign/campaign.utils.ts` | **new** — `describeError`, `classifyEmailError`, `formatCampaignId`, `nextCampaignId`, `isStaleProcessing` (pure, unit-testable) |
| `campaign/campaign.service.ts` | rewritten orchestration: `getStatus`, background `send`, `processCandidate`, run lock, retry loop |
| `campaign/campaign.types.ts` | `CampaignStartResponse`, `CampaignStatusResponse`, `FollowUpCounts`, `CampaignRunResponse`; `CampaignSendResponse` narrowed to the dry-run shape |
| `campaign/campaign.controller.ts` | `GET status`; `send` returns the union; documents the 409 |
| `campaign/index.ts` | re-exports the two new files |
| `campaign/campaign.service.spec.ts` | 33 unit tests (was 22) |
| `test/campaign.e2e-spec.ts` | 14 e2e tests (was 12): `STARTED`, `409`, `GET /status` |
| `README.md` | status endpoint, async send, retry semantics |

Nothing outside `src/modules/campaign` changed: `GoogleSheetService`,
`TemplateService`, `EmailService` and every config namespace are untouched.

---

## 4. The single-run lock

```ts
private isCampaignRunning = false;
private activeCampaignId: string | null = null;
```

- The lock is taken **before** the sheet is read, so two overlapping requests
  cannot both pass the eligibility check.
- A dry run takes the lock too (it reads the same rows) and releases it inline.
- A real send hands ownership of the lock to the background run, which releases
  it in a `finally` — including when the run aborts.
- While the lock is held, any further `POST /campaign/send` — dry or real —
  answers **409** with a message naming the running campaign.

> **Limitation (accepted for V1):** the flag is per process. Running two
> instances of the app would defeat it — that is what the PRD calls out as a V2
> item (distributed locking).

---

## 5. Campaign identifiers

`campaign-YYYYMMDD-NNN`, e.g. `campaign-20260927-001`.

- The sequence is **derived from the sheet**: every existing `campaign_id` with
  today's prefix is parsed and `max + 1` is used. There is no database, so this
  is what makes the numbering survive a restart instead of re-issuing `-001`.
- `campaign_id` is stamped on every row the run touches — both on the way into
  `PROCESSING` and again on `FAILED`, so a row is attributable even if it never
  settled.
- A dry run reports `campaign-YYYYMMDD-dry` and **writes nothing**, so it never
  consumes a real sequence number.

> Watch out when parsing these yourself: `parseInt('-004')` is `-4`, which is why
> `nextCampaignId` strips the separator explicitly. There is a test for it.

---

## 6. Stale `PROCESSING` recovery

A row is re-eligible when its `status` is `PROCESSING` **and**
`processing_started_at` is older than `STALE_PROCESSING_THRESHOLD_MINUTES`
(default 30). A `PROCESSING` row with a missing or unparseable timestamp is also
treated as stale — under the single-run lock nothing can legitimately be in
flight. Recovered rows are logged by row number, never recovered silently.

This pulls one item of Phase 4 forward, because without it a row interrupted by a
crash would be stuck in `PROCESSING` forever. The trade-off is the one the PRD
accepts: a crash in the window between "provider accepted" and "row settled" can
still produce a duplicate on recovery.

---

## 7. Error classification and retries

`classifyEmailError()` flattens the provider message and matches it against two
ordered pattern lists. **Non-retryable wins** — retrying a permanent failure only
burns the attempt budget and risks a duplicate.

| Class | Examples matched | Behaviour |
|---|---|---|
| Non-retryable | `550`/`551`/`553`/`554`, "no such user", "unknown recipient", "mailbox unavailable", `401`/`403`, `535`, "invalid credentials", `400` | fail immediately, 1 attempt |
| Retryable | `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`, "socket hang up", `429`, "rate limit", "too many", `throttled", `502`/`503`/`504`, "service unavailable", "temporarily unavailable" | retry after `EMAIL_DELAY_MS`, up to the budget |
| Anything else | — | treated as **non-retryable** |

That last row is a safety decision, not an oversight: an unrecognised failure may
still have delivered the mail, and a second attempt would duplicate it. When you
hit one, add the provider's real message to the non-retryable list (or retryable,
if it is genuinely transient).

**Budget.** `EMAIL_MAX_RETRIES=2` means 3 attempts in total (`1 + retries`).
Retries happen *in place*, inside the same run, separated by `EMAIL_DELAY_MS`.
`attempts` is the durable counter: a `PENDING` row that already used the whole
budget is skipped (and logged) instead of being retried forever, so resetting it
to `PENDING` alone would not help — reset `attempts` to `0` as well.

---

## 8. API changes

### `GET /campaign/status` (new)

```bash
curl http://localhost:3000/api/campaign/status
```

```json
{
  "connection": { "spreadsheetId": "1X8K4...", "sheetName": "Candidates", "driver": "apps_script" },
  "counts": { "total": 55, "pending": 3, "processing": 2, "sent": 48, "failed": 2 },
  "followUp": { "notScheduled": 55, "scheduled": 0, "processing": 0, "sent": 0, "failed": 0, "enabled": 0 },
  "running": true,
  "activeCampaignId": "campaign-20260927-001"
}
```

Read live from the sheet on every call — the sheet, not memory, remains the
source of truth. `followUp` is aggregation only; [`guide-3.md`](./guide-3.md) covers the Phase 4 work
that acts on those columns.

### `POST /campaign/send` (behaviour change)

| | Before | Now |
|---|---|---|
| `?dryRun=true` | `200` + `results[]` | unchanged, plus `status: 'DRY_RUN_COMPLETED'` and `campaignId` |
| `?dryRun=false` | `200` + per-row `results[]`, request held open ~`limit × EMAIL_DELAY_MS` | `200` + `{ status: 'STARTED', campaignId, total }` immediately |
| second concurrent call | double-send risk | `409 Conflict` |

A real send is no longer a synchronous request because a 50-row batch at
`EMAIL_DELAY_MS=2000` takes ~100 seconds and would sit behind a proxy timeout.
The dry run stayed synchronous on purpose: rendering is fast, and returning the
rendered emails *is* what a dry run is for.

Both responses are `200`; the `status` field distinguishes them. This is a
**breaking change for any script that read `results[]` from a real send** —
read progress from `GET /campaign/status` instead.

---

## 9. What one row costs in sheet writes

`updateRow` is always called with a sparse patch, and it groups only *adjacent*
columns into one `setValues` span, so one call can fan out into several HTTP
writes:

| Step | Columns | `updateRow` calls | HTTP writes |
|---|---|---|---|
| Enter `PROCESSING` | `status` (E), `campaign_id` (J), `processing_started_at` (P) | 1 | 3 |
| Settle `SENT` | `status`…`attempts` (E–I, adjacent) | 1 | 1 |
| Settle `FAILED` | `status` (E), `error`…`campaign_id` (H–J) | 1 | 2 |

So a successful row costs **4 HTTP writes** and a failed one **5**. This matters
because the PRD flags Sheets rate limits as a risk, and it is the reason the
settle step is a single call: the E–I block is one span for free, and clearing
`processing_started_at` would have added a sixth write per row for no benefit.

`campaign_id` is written twice on the failure path (once at `PROCESSING`, once at
`FAILED`). That redundancy is deliberate: the template-failure path settles
straight to `FAILED` without ever entering `PROCESSING`, so without it those rows
would carry no campaign id.

---

## 10. Configuration

No new variables — Phase 3 activates two that already existed in
`campaign.config.ts` but were unused:

| Variable | Default | Used for |
|---|---|---|
| `EMAIL_MAX_RETRIES` | `2` | attempts per row = `1 + EMAIL_MAX_RETRIES` |
| `STALE_PROCESSING_THRESHOLD_MINUTES` | `30` | when a `PROCESSING` row becomes re-eligible |
| `EMAIL_DELAY_MS` | `2000` | gap between sends **and** between retries of one row |
| `SEND_DEFAULT_DRY_RUN` | `true` | fallback when `?dryRun` is absent |

`CRON_*` was still unread at this point — see [`guide-3.md`](./guide-3.md).

---

## 11. Operating it

```bash
# 1. Prove the pipeline on one person. Always do this first.
curl -X POST 'http://localhost:3000/api/campaign/send?dryRun=false&limit=1'

# 2. Check the sheet: that row should now be SENT with a message_id and attempts=1.

# 3. Review the next batch without sending.
curl 'http://localhost:3000/api/campaign/preview?limit=10'

# 4. Fire the batch. This returns immediately.
curl -X POST 'http://localhost:3000/api/campaign/send?dryRun=false'

# 5. Watch it.
watch -n 10 'curl -s http://localhost:3000/api/campaign/status | jq .counts'
```

Things worth knowing:

- **Filtering to one role** (`?role=BACKEND`) is applied to eligibility, so a
  campaign can be a subset of the sheet.
- **`limit` truncation is visible**: the response/log says how many eligible rows
  were left unprocessed, so a cap never looks like "that was everything".
- **A `FAILED` row is not retried by the next run** — it is no longer `PENDING`.
  To retry it, set `status` back to `PENDING` **and** `attempts` to `0`.
- **Killing the process mid-batch** leaves at most one row in `PROCESSING`. On the
  next run it is either picked up as stale (after the threshold) or left alone;
  already-`SENT` rows are never re-sent.

---

## 12. Tests

```bash
npm test          # 80 unit tests
npm run test:e2e  # 14 e2e tests
```

The Phase 3 suite concentrates on the risky behaviour:

- **State machine** — the exact `PROCESSING` then `SENT` write sequence, and the
  order in which rows are touched.
- **No double sends** — `SENT`/`FAILED` rows are never eligible; a real send is
  never re-entered; and a *lost sheet write after a delivered mail* aborts the
  run instead of resending the row.
- **Isolation** — one row throwing leaves the rest of the batch running.
- **Retries** — retryable succeeds on attempt 2; permanent fails on attempt 1;
  budget exhaustion records the last reason and `attempts=3`.
- **Lock** — 409 for a concurrent real send *and* for a dry run during one; the
  lock is released after an aborted run.
- **Stale recovery** — a 45-minute-old `PROCESSING` row is re-sent, a 2-minute-old
  one is left alone, one with no timestamp is recovered.
- **Campaign ids** — a dry run does not consume a sequence number; a second run
  continues from the highest id on the sheet.

Timing-sensitive assertions never sleep: the tests hold the provider open with a
manually resolved promise and poll `GET /campaign/status`.

---

## 13. Deliberate decisions

| Decision | Why |
|---|---|
| Dry run stays synchronous, real send goes to the background | A dry run's value is its response body; a real send's 100-second HTTP request is not worth keeping |
| Unknown errors are non-retryable | A duplicate email is worse than a failed one |
| Retries happen in place, not on the next run | Keeps the loop simple and the outcome visible in one run's logs; the daily cron is a separate Phase 4 concern |
| `campaign_id` is stamped at `PROCESSING` time | A crashed row stays attributable to the run that touched it |
| `processing_started_at` is not cleared on settle | One fewer write per row, and it remains a useful audit trail |
| Status endpoint takes no query params | Counts are cheap to compute and role-filtered counts invite more questions than they answer |

---

## 14. Built in Phase 5

Everything Phase 5 added sits on top of this layer and is documented in
[`guide-4.md`](./guide-4.md):

- **Graceful shutdown** — `CampaignService.onApplicationShutdown` drains the
  detached batch, so an interrupted row is no longer the normal case.
- **`GET /health`**, the API-key guard, structured per-candidate logging, and
  the README.

The batch semantics described above are unchanged.

Cron, the daily cycle and follow-ups all shipped in Phase 4 — see
[`guide-3.md`](./guide-3.md).

Phase 4 now makes that `inReplyTo` real: follow-ups thread under the initial
email's `message_id` (see `guide-3.md`).
