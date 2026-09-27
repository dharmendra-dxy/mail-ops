# MailOps

Personal NestJS backend that automates role-based outreach emails, using a **Google Sheet as the
only store** — no database.

> **Status: Phase 1 and Phase 2 complete.** Sheet I/O, validation, role templates, dry-run and
> real sending are working. Campaign orchestration, cron and follow-ups land in Phases 3–4.
> See [`src/specs/guide.md`](src/specs/guide.md) for the full development guide.

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
| `attempts` | Retry count |
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
| `POST /campaign/send` | Dry run by default; `?dryRun=false` sends for real |
| `POST /email/verify` | Check the SMTP/OAuth2 credentials before running a campaign |

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

### Send

```bash
# Dry run (the default): renders everything, no provider call, no sheet write
curl -X POST 'http://localhost:3000/api/campaign/send?limit=3'

# Real send, one recipient only — the recommended way to prove the pipeline
curl -X POST 'http://localhost:3000/api/campaign/send?dryRun=false&limit=1'
```

A row is eligible when it passes validation **and** is still `PENDING`, so a second call
never re-sends a batch. Sends are sequential with `EMAIL_DELAY_MS` between them, a
failing row is recorded and the batch continues, and each outcome is written straight
back to the sheet. An unrecognised `dryRun` value is rejected with 400 rather than being
treated as `false`.

## Email

Sending goes through the `EmailProvider` interface
(`src/modules/email/providers/email.provider.ts`); nodemailer is the only implementation.
The campaign layer never talks to nodemailer directly, so adding SES/Resend later is a new
provider, not a rewrite.

Your email copy lives in `src/modules/template/templates/mail-templates.ts` — three roles
(`FRONTEND`, `BACKEND`, `FULL_STACK`) × two variants (`initial`, `follow_up`), using the
Handlebars variables `{{name}}`, `{{firstName}}`, `{{company}}`, `{{role}}` and
`{{roleLabel}}`. The `follow_up` variant can already be previewed with `?type=follow_up`;
Phase 4 is what sends it automatically.

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
| `MAIL_*` | see above | Outgoing mail transport |
| `SEND_DEFAULT_DRY_RUN` | `true` | Fallback for `POST /campaign/send` when `?dryRun` is absent |
| `EMAIL_DELAY_MS` | `2000` | Delay between sends |
| `EMAIL_MAX_RETRIES` | `2` | Retry cap (Phase 3) |
| `STALE_PROCESSING_THRESHOLD_MINUTES` | `30` | Stale `PROCESSING` recovery (Phase 4) |
| `CRON_*` | – | Daily schedule (Phase 4) |

## Project layout

```text
src/
├── common/filters/          # global HTTP exception filter
├── config/                  # typed, centralised env configuration
├── modules/
│   ├── campaign/            # connect-sheet, validate, preview, send
│   ├── email/               # EmailProvider abstraction + nodemailer provider
│   ├── google-sheet/        # drivers, repository, service, Candidate entity
│   └── template/            # per-role email copy + Handlebars rendering
└── specs/                   # PRD, plan, architecture, development guide
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
