# MailOps

Personal NestJS backend that automates role-based outreach emails, using a **Google Sheet as the
only store** — no database.

> **Status: complete (Phases 1–5).** Sheet I/O, validation, role templates, dry-run and real
> sending, batch orchestration, the daily cron with follow-ups, plus a health endpoint, an API
> key guard, structured logs and graceful shutdown.
> Guides: [`guide.md`](src/specs/guide.md) (Phases 1–2), [`guide-2.md`](src/specs/guide-2.md)
> (Phase 3), [`guide-3.md`](src/specs/guide-3.md) (Phase 4),
> [`guide-4.md`](src/specs/guide-4.md) (Phase 5).

## Requirements

- Node.js 20+
- A Google Sheet with the columns listed under [Sheet columns](#sheet-columns)
- Either an Apps Script web app (no Google OAuth in this app) **or** a service account shared
  with the sheet

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run start:dev
```

The API is served under the `API_PREFIX` prefix (`http://localhost:3000/api` by default).

## How the app reaches your Google Sheet

Google's Sheets API has no unauthenticated mode, so "no OAuth in the app" is achieved by
authorising **once** in the browser. Two interchangeable drivers are available; pick one with
`GOOGLE_SHEET_DRIVER`.

### 1. `apps_script` (default, recommended)

An Apps Script web app runs *as you* and exposes a tiny JSON bridge, so the backend needs no
Google credentials at all.

1. Open the target sheet → **Extensions → Apps Script**.
2. Replace the sample code with the contents of [`scripts/google-sheet.gs`](scripts/google-sheet.gs) and save.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the Web app URL into `.env`:

```env
GOOGLE_SHEET_DRIVER=apps_script
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
```

The script supports three actions: `meta` (tab names), `read` (rows as a 2-D array) and
`update` (targeted `setValues` on an A1 range).

### 2. `service_account`

Authenticates as a service identity instead of a user. No OAuth flow, but the sheet must be
shared with the service account as an **Editor**.

1. Share the sheet with `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
2. Set the driver:

```env
GOOGLE_SHEET_DRIVER=service_account
```

The Apps Script web app is the only option that also works when the sheet stays completely
private to you.

## Sheet columns

Row 1 is the header. Only `name`, `email`, `company` and `role` are required; the rest default
sensibly and are written back by later phases. Header matching is case- and separator-insensitive
(`Follow Up Days` == `follow_up_days`).

| Column | Purpose |
|---|---|
| `name` | Recipient name — required |
| `email` | Recipient email — required, must be a valid address |
| `company` | Company name — required |
| `role` | `FRONTEND` / `BACKEND` / `FULL_STACK` — required |
| `status` | `PENDING` / `PROCESSING` / `SENT` / `FAILED` (defaults to `PENDING`) |
| `sent_at` | Timestamp of a successful send |
| `message_id` | Provider message id |
| `error` | Failure reason |
| `attempts` | Attempts used; a row is skipped once it reaches `1 + EMAIL_MAX_RETRIES` |
| `campaign_id` | Batch identifier, e.g. `campaign-20260927-001` |
| `follow_up_enabled` | `YES` / `NO` (defaults to `NO`) |
| `follow_up_days` | Days after `sent_at` to trigger the follow-up |
| `follow_up_status` | `NOT_SCHEDULED` / `SCHEDULED` / `PROCESSING` / `SENT` / `FAILED` |
| `follow_up_sent_at` | Timestamp of the follow-up send |
| `follow_up_message_id` | Provider message id for the follow-up |
| `processing_started_at` | Used to recover stale `PROCESSING` rows after a crash |

## API

| Endpoint | Purpose |
|---|---|
| `POST /campaign/connect-sheet` | Register a spreadsheet URL/id for this process and verify it is reachable |
| `GET /campaign/validate` | Validate every row and return counts plus row-level errors |
| `GET /campaign/preview` | Counts plus rendered subject/body per candidate — sends nothing |
| `GET /campaign/status` | Live counts by status, follow-up counts, and whether a run is in flight |
| `POST /campaign/send` | Dry run by default; `?dryRun=false` starts a real background run |
| `GET /scheduler/status` | Whether a cron job is registered, its schedule, and the last cycle result |
| `POST /scheduler/run` | Run the daily cycle now: due initial emails, then due follow-ups |
| `POST /email/verify` | Check the SMTP/OAuth2 credentials before running a campaign |
| `GET /health` | Reachability of the Sheet and the mail server — `200` up, `503` degraded |

### Health

```bash
curl -s http://localhost:3000/api/health | jq
```

```json
{
  "status": "up",
  "checkedAt": "2026-09-27T02:31:04.882Z",
  "uptimeSeconds": 8134,
  "checks": [
    {
      "name": "googleSheet",
      "status": "up",
      "durationMs": 214,
      "detail": "1 tab(s) reachable, \"Candidates\" present via apps_script"
    },
    {
      "name": "email",
      "status": "up",
      "durationMs": 388,
      "detail": "SMTP credentials accepted for me@gmail.com via smtp.gmail.com"
    }
  ]
}
```

It probes both dependencies concurrently and never throws: `status` is `up` only when both
answer, otherwise `degraded` with **503** and the reason on the failing check. A probe that
hangs is abandoned after `HEALTH_CHECK_TIMEOUT_MS`, and a multi-line provider error is
collapsed to one line. This is the only endpoint that stays reachable without an API key, so a
monitor can always ask. The body reports tab names, a driver and a mail host — never a
credential.

### Connect a sheet

```bash
curl -X POST http://localhost:3000/api/campaign/connect-sheet \
  -H 'Content-Type: application/json' \
  -d '{
    "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/1X8K4.../edit",
    "sheetName": "Candidates"
  }'
```

`spreadsheetUrl` accepts a full URL or a bare spreadsheet id. `sheetName` is optional and
defaults to `SHEET_NAME`. There is no database in V1, so the connection lives for the lifetime of
the process; `GOOGLE_SPREADSHEET_ID` + `SHEET_NAME` are used after a restart.

### Validate rows

```bash
curl http://localhost:3000/api/campaign/validate
```

```json
{
  "connection": { "spreadsheetId": "1X8K4...", "sheetName": "Candidates", "driver": "apps_script" },
  "total": 55,
  "valid": 53,
  "invalid": 2,
  "errors": [
    { "row": 12, "field": "email", "message": "email is not a valid email address" },
    { "row": 31, "field": "role", "message": "role must be one of: FRONTEND, BACKEND, FULL_STACK" }
  ]
}
```

`row` is the 1-based Google Sheets row number, so it lines up with the sheet you are looking at.

### Preview rendered emails

```bash
curl 'http://localhost:3000/api/campaign/preview?limit=2&role=FRONTEND'
```

Query params: `limit` (default 5, max 50), `role` (`FRONTEND`/`BACKEND`/`FULL_STACK`),
`type` (`initial`/`follow_up`). Returns counts, how many rows are eligible, and the
rendered subject and body — read this before every real send.

### Status

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

`counts` and `followUp` are read live from the sheet on every call. `running` is the
single-run lock: while it is `true`, `POST /campaign/send` answers **409 Conflict**.

### Send

```bash
# Dry run (the default): renders everything, no provider call, no sheet write
curl -X POST 'http://localhost:3000/api/campaign/send?limit=3'

# Real send, one recipient only — the recommended way to prove the pipeline
curl -X POST 'http://localhost:3000/api/campaign/send?dryRun=false&limit=1'
```

A row is eligible when it passes validation and is still `PENDING` (or is a stale
`PROCESSING` leftover), so a second call never re-sends a batch. An unrecognised
`dryRun` value is rejected with 400 rather than being treated as `false`.

A dry run answers immediately with the rendered emails. A real send answers
`{"status":"STARTED","campaignId":"campaign-20260927-001","total":50}` and then runs in
the background, because a 50-row batch takes about `50 × EMAIL_DELAY_MS`:

```bash
# watch it progress
watch -n 5 'curl -s http://localhost:3000/api/campaign/status | jq .counts'
```

Each row walks `PENDING → PROCESSING → SENT | FAILED`, and `PROCESSING` is written
*before* the provider is called, so a crash mid-batch leaves an auditable trail
instead of a silently re-sent row. Retryable failures (timeouts, rate limits,
network) are retried up to `EMAIL_MAX_RETRIES`; permanent ones (bad address, auth)
fail immediately. Every outcome is written straight back to the sheet, one failing
row never stops the batch, and every processed row is stamped with the
`campaign_id` of the run that touched it.

### Scheduler

`GET /api/scheduler/status` reports whether a cron job is actually registered:

```json
{
  "enabled": true,
  "registered": true,
  "jobName": "mailops-daily-campaign",
  "expression": "0 8 * * *",
  "timezone": "Asia/Kolkata",
  "batchLimit": 50,
  "lastRunAt": "2026-09-27T02:34:11.204Z",
  "lastRun": { "initial": { "eligible": 3, "sent": 3, "failed": 0 }, "followUp": { "eligible": 2, "sent": 2, "failed": 0 } },
  "lastError": null,
  "lastErrorAt": null
}
```

With `CRON_ENABLED=false` there is **no job object at all** — `registered` is `false` and
`expression`/`timezone` are `null`. The daily run is a single entry point that does two things in
order, under one lock: sends every due initial email, then sends every due follow-up.

To run a cycle immediately instead of waiting for the clock:

```bash
curl -X POST http://localhost:3000/api/scheduler/run
```

It returns `{ "trigger": "MANUAL", "skipped": null, "result": { ... } }`. If a campaign is already
running, `skipped` is `RUN_IN_PROGRESS` and nothing is sent.

### Follow-ups

A row opts in with `follow_up_enabled=YES` and a `follow_up_days` value. The due time is
`sent_at + follow_up_days`, computed on every run rather than stored, so editing the column takes
effect immediately. Each cycle:

1. Promotes `NOT_SCHEDULED` rows to `SCHEDULED` as soon as the initial email is on record, so the
   sheet shows the queue before anything fires.
2. Sends a due follow-up for rows that are `SENT`, opted in, and not already followed up —
   including a `follow_up_status=PROCESSING` row left behind by a crash.

A follow-up walks `SCHEDULED → PROCESSING → SENT | FAILED` in its own columns
(`follow_up_status`, `follow_up_sent_at`, `follow_up_message_id`), is threaded under the original
message via `in_reply_to`, and never touches the initial email's record. A follow-up that fails is
**not** retried automatically — set `follow_up_status` back to `SCHEDULED` to try again.

To see one fire without waiting days, set `follow_up_enabled=YES` and `follow_up_days=0` on a row
that is already `SENT`, then trigger a cycle:

```bash
curl -X POST http://localhost:3000/api/scheduler/run | jq .result.followUp
```

## Email

Sending goes through the `EmailProvider` interface
(`src/modules/email/providers/email.provider.ts`); nodemailer is the only implementation
(`MAIL_PROVIDER`). `EmailService` is the only thing the campaign layer depends on, so adding
SES/Resend later is a new class plus one `case` in `email.module.ts` — no change to
`CampaignService`. An unknown `MAIL_PROVIDER` refuses to boot rather than leaving the app
unable to send.

Your email copy lives in `src/modules/template/templates/mail-templates.ts` — three roles
(`FRONTEND`, `BACKEND`, `FULL_STACK`) × two variants (`initial`, `follow_up`), using the
Handlebars variables `{{name}}`, `{{firstName}}`, `{{company}}`, `{{role}}` and
`{{roleLabel}}`. The `follow_up` variant can be previewed with `?type=follow_up` and is what the
daily cycle sends.

> `MAIL_HOST` takes precedence over `MAIL_SERVICE`: nodemailer's service presets carry their
> own host/port and would otherwise silently override it.

```env
MAIL_SERVICE=gmail
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_AUTH_TYPE=password     # or oauth2
MAIL_FROM=you@gmail.com
MAIL_USER=you@gmail.com
MAIL_PASSWORD=<gmail app password>
```

For `MAIL_AUTH_TYPE=password` use a Gmail **App Password**
(Google Account → Security → 2-Step Verification → App passwords). For `oauth2`, the transport
reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` with the
`sheets` + `gmail.send` scopes. Verify either with:

```bash
curl -X POST http://localhost:3000/api/email/verify
```

## API access

Set `API_KEY` and every endpoint except `GET /health` requires it:

```bash
curl -H 'x-api-key: your-key' http://localhost:3000/api/campaign/status
curl -H 'Authorization: Bearer your-key' http://localhost:3000/api/campaign/status
```

```env
API_KEY_ENABLED=false   # optional; setting API_KEY alone already enables the guard
API_KEY=
```

With no key configured the API is open, which is what you want on localhost. The comparison is
constant-time, and a wrong key gets the same message as a missing one so neither the text nor
the timing narrows a guess. The guard is registered globally (`APP_GUARD`), so a new controller
cannot accidentally ship unprotected — a route opts out with `@Public()`, and today only
`/health` does.

Note the sheet still holds every recipient, so the key protects the API, not the data: the Apps
Script web app's own "Anyone" access is the wider surface, and it is a trade-off of the
credential-free driver.

## Shutdown

`Ctrl-C`, `SIGTERM` or a container stop waits for the row currently being sent to finish
writing to the sheet before the process exits (`SHUTDOWN_DRAIN_TIMEOUT_MS`, default 30s). New
campaigns are refused with 409 as soon as draining starts. This exists because `POST
/campaign/send` runs detached — a `PROCESSING` row killed mid-send would otherwise only be
recovered by stale-`PROCESSING` detection 30 minutes later, and the mail may have gone out
anyway.

## Logging

Per-candidate lines are structured as `event=<name> key=value …`, so a batch can be followed
without reading prose:

```text
event=campaign.started campaignId=campaign-20260927-001 candidates=50 type=initial
event=candidate.sent row=7 to=hr@globex.com kind=initial campaignId=campaign-20260927-001 attempt=1 maxAttempts=3 messageId=<abc@…>
event=send.attempt.retrying row=9 to=hr@initech.com kind=initial attempt=1 maxAttempts=3 reason="ETIMEDOUT connection timed out"
event=candidate.failed row=9 to=hr@initech.com kind=initial attempt=3 maxAttempts=3 reason="503 service unavailable"
event=campaign.finished campaignId=campaign-20260927-001 sent=48 failed=2
```

Useful events: `campaign.started|finished|aborted`, `candidate.sent|failed|template_failed`,
`send.attempt.retrying|permanent_failure|budget_exhausted`, `cycle.started|finished|skipped`,
`followup.scheduled|recovered_stale|skipped_failed`, `dryrun.rendered`,
`cron.registered|stopped|disabled`, `shutdown.drain.started|completed|timed_out`. Full rendered
bodies stay at `debug` level; a 50-row dry run prints 50 subject lines, not 50 emails.

## Configuration

All environment variables are read once in `src/config`; nothing else touches `process.env`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `3000` | HTTP port |
| `API_PREFIX` | `api` | Route prefix |
| `SHEET_NAME` | `Candidates` | Tab to operate on |
| `GOOGLE_SHEET_DRIVER` | `apps_script` | `apps_script` or `service_account` |
| `GOOGLE_APPS_SCRIPT_URL` | – | Deployed web app URL (apps_script driver) |
| `GOOGLE_SHEET_TIMEOUT_MS` | `15000` | Sheet request timeout |
| `GOOGLE_SPREADSHEET_ID` | – | Default spreadsheet |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | – | service_account driver |
| `MAIL_PROVIDER` | `nodemailer` | Registered `EmailProvider`; an unknown value refuses to boot |
| `MAIL_*` | see above | Outgoing mail transport |
| `SEND_DEFAULT_DRY_RUN` | `true` | Fallback for `POST /campaign/send` when `?dryRun` is absent |
| `EMAIL_DELAY_MS` | `2000` | Delay between sends |
| `EMAIL_MAX_RETRIES` | `2` | Retries per row for retryable failures, so 3 attempts in total |
| `STALE_PROCESSING_THRESHOLD_MINUTES` | `30` | A `PROCESSING` row older than this is re-eligible |
| `CRON_ENABLED` | `false` | `false` registers no cron job at all |
| `CRON_HOUR` / `CRON_MINUTE` | `8` / `0` | Local time of the daily run |
| `CRON_TIMEZONE` | `Asia/Kolkata` | IANA zone the daily run is timed in |
| `CRON_JOB_NAME` | `mailops-daily-campaign` | Registry key of the job |
| `CRON_BATCH_LIMIT` | `50` | Cap per run, applied to initial emails and follow-ups separately |
| `API_KEY` | – | Shared secret required on every endpoint except `/health`; setting it enables the guard |
| `API_KEY_ENABLED` | derived | Overrides the above; `true` with no key refuses to boot |
| `HEALTH_CHECK_TIMEOUT_MS` | `10000` | Per-probe timeout in `GET /health` |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `30000` | How long shutdown waits for the in-flight row |

## Project layout

```text
src/
├── common/
│   ├── decorators/          # @Public(), the opt-out from the API key guard
│   ├── filters/             # global HTTP exception filter
│   ├── guards/              # ApiKeyGuard (registered globally)
│   └── logger/              # structured `event=… key=value` log formatter
├── config/                  # typed, centralised env configuration
├── modules/
│   ├── campaign/            # connect-sheet, validate, preview, status, send
│   ├── email/               # EmailProvider abstraction + nodemailer provider
│   ├── google-sheet/        # drivers, repository, service, Candidate entity
│   ├── health/              # GET /health, sheet + mail probes
│   ├── scheduler/           # daily cron registration, cycle trigger, status
│   └── template/            # per-role email copy + Handlebars rendering
└── specs/                   # PRD, plan, architecture, development guides
scripts/google-sheet.gs      # Apps Script bridge to deploy
```

Writes always target individual cells: patched columns are grouped into contiguous spans and
written with `setValues`, so untouched cells in a row are never cleared.

## Scripts

```bash
npm run start:dev   # watch mode
npm run build       # compile
npm run lint        # eslint --fix
npm test            # unit tests
npm run test:e2e    # e2e tests
```
