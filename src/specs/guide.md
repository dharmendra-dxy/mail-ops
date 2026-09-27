# MailOps — Development Guide

What has actually been built, how to run it, and what is deliberately **not** done yet.
Companion to `prd.md` (what the product should be), `plan.md` (the phases) and
`../architecture.md` (the code conventions).

**Status: Phase 1 and Phase 2 complete. Phase 3+ not started.**

> This guide describes the state of the project after Phase 2. **Phase 3 is now
> implemented** — see [`guide-2.md`](./guide-2.md) for the campaign state machine,
> the single-run lock, retries and `GET /campaign/status`. Section 9 below is
> superseded by it.

---

## 1. Where the project stands

| Phase | Plan | Status | Delivered |
|---|---|---|---|
| 1 | Foundation & Sheets I/O | **Done** | OAuth-free sheet access, row mapping, validation, `connect-sheet` |
| 2 | Templates & sending core | **Done** | Per-role templates, Handlebars rendering, dry-run, first real send |
| 3 | Orchestration & state machine | Not started | — |
| 4 | Cron & follow-ups | Not started | — |
| 5 | Hardening & docs | Not started | — |

### Deviations from the plan, and why

| Plan said | We did | Reason |
|---|---|---|
| `GmailProvider` using the Gmail API | `NodemailerProvider` over SMTP | Your decision. Nodemailer also gives a plain-SMTP path (App Password), so no Google OAuth is needed for sending either. |
| Set up Google OAuth (client id/secret/refresh token) | Apps Script web app bridge | The OAuth client was in *Testing* mode, so its refresh token had already expired (`unauthorized_client`). The bridge needs no Google credentials in this app at all. |
| Templates keyed `frontend` / `backend` / `full-stack` | `FRONTEND` / `BACKEND` / `FULL_STACK` | Matches the sheet's `role` values, so there is no mapping layer to get wrong. |
| `POST /campaign/send?dryRun=` (Phase 2) | Same, plus `limit` | You need a way to send **one** email before trusting a batch. |
| Phase 2 also writes `SENT`/`FAILED` back | Yes, but no `PROCESSING` guard | Writing the outcome is what prevents re-sending the same row. The `PROCESSING` lock, retry budget and campaign lock belong to the Phase 3 state machine. |

---

## 2. Architecture in one picture

```text
HTTP  →  CampaignController  →  CampaignService  →  GoogleSheetService  →  SheetDriver  →  Google Sheet
                  │                    │                    │
                  │                    └── TemplateService ─┘ (Handlebars render)
                  │
                  └── EmailService → EmailProvider (NodemailerProvider) → SMTP server → mailbox
```

Rules the code follows (from `../architecture.md`):

- Controllers only parse input and call a service. No business logic in controllers.
- Business logic lives in services; sheet access lives in the repository/driver layer.
- `process.env` is read **only** in `src/config`. Everything else uses `ConfigService`.
- Static values live in `*.constant.ts`; environment values in `src/config`.
- Every env-dependent knob is configurable; nothing is hardcoded.

---

## 3. Module map

```text
src/
├── common/filters/http-exception.filter.ts   # one error shape for the whole API
├── config/                                   # the ONLY place process.env is read
│   ├── app.config.ts          # NODE_ENV, PORT, API_PREFIX
│   ├── campaign.config.ts     # EMAIL_DELAY_MS, EMAIL_MAX_RETRIES, SEND_DEFAULT_DRY_RUN, stale threshold
│   ├── google-sheet.config.ts # driver choice, Apps Script URL, service-account creds, timeouts
│   └── mail.config.ts         # SMTP host/port/secure, sender, auth type, OAuth2 creds
├── modules/
│   ├── google-sheet/
│   │   ├── drivers/
│   │   │   ├── apps-script.driver.ts        # OAuth-free JSON bridge (default)
│   │   │   └── service-account.driver.ts    # service identity fallback
│   │   ├── entities/candidate.entity.ts     # one sheet row + its validation rules
│   │   ├── google-sheet.repository.ts       # transport calls only
│   │   ├── google-sheet.service.ts          # row ↔ Candidate mapping, targeted writes
│   │   ├── google-sheet.utils.ts            # spreadsheet-id parsing, A1 notation, column grouping
│   │   └── google-sheet.constant.ts         # column order, status/role enums, driver token
│   ├── template/
│   │   ├── templates/mail-templates.ts      # ← EDIT YOUR EMAIL COPY HERE
│   │   ├── template.service.ts              # getTemplate() / render() / buildContext()
│   │   └── template.constant.ts             # template types, variables, role labels
│   ├── email/
│   │   ├── providers/email.provider.ts      # the interface CampaignService depends on
│   │   ├── providers/nodemailer.provider.ts # the only implementation
│   │   └── email.service.ts                 # send() / verify()
│   └── campaign/
│       ├── dto/                             # connect-sheet, preview-candidates, send-campaign
│       ├── campaign.service.ts              # validate / preview / send
│       └── campaign.controller.ts           # the 5 endpoints
└── specs/                                   # prd.md, plan.md, architecture.md, this file

scripts/google-sheet.gs                       # deploy this to your sheet
```

---

## 4. Google Sheets access (Phase 1)

Google has no unauthenticated Sheets API, so the app reaches your sheet through an
**Apps Script web app** that you authorise once in the browser. The backend holds no
Google credentials for this.

```env
GOOGLE_SHEET_DRIVER=apps_script
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
GOOGLE_SPREADSHEET_ID=1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I
SHEET_NAME=Candidates
```

**If you ever edit `scripts/google-sheet.gs`:** Deploy → Manage deployments → Edit →
*Version: New version*. A deployment pinned to an older revision keeps serving the old
code — the response contains `"version"` so you can check which revision is live:

```bash
curl https://script.google.com/macros/s/YOUR_ID/exec
# {"ok":true,"version":"2026-09-27.1", ...}
```

The driver is chosen by `GOOGLE_SHEET_DRIVER`; `service_account` is a drop-in
alternative that authenticates as a service identity instead (the sheet must be shared
with `GOOGLE_SERVICE_ACCOUNT_EMAIL` as Editor).

### Sheet columns

Row 1 is the header; only `name`, `email`, `company`, `role` are required. Header
matching ignores case and treats spaces/hyphens as underscores, so `Follow Up Days`
and `follow_up_days` are the same column. Unknown extra columns are ignored.

| Column | Written by | Notes |
|---|---|---|
| `name`, `email`, `company`, `role` | you | `role` ∈ FRONTEND / BACKEND / FULL_STACK |
| `status` | app | PENDING → SENT / FAILED (Phase 3 adds PROCESSING) |
| `sent_at`, `message_id` | app | ISO timestamp; nodemailer message id |
| `error` | app | Single-line failure reason |
| `attempts` | app | Incremented on every send attempt |
| `campaign_id` | Phase 3 | Not used yet |
| `follow_up_*` (5 columns) | Phase 4 | Read and validated now, unused so far |
| `processing_started_at` | Phase 3/4 | Stale-PROCESSING recovery |

**Writes never touch a whole row.** Patched columns are grouped into contiguous spans
and written with `setValues`, so a `status` write cannot blank the rest of the row.
Writing `status` + `sent_at` + `message_id` + `error` + `attempts` is a *single* write
to `E:I` because those columns are adjacent.

---

## 5. Email sending (Phase 2)

### Transport

```env
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_AUTH_TYPE=password     # or oauth2
MAIL_FROM=you@gmail.com
MAIL_USER=you@gmail.com
MAIL_PASSWORD=<gmail app password>
```

> **Gotcha worth knowing:** nodemailer's `service` presets (e.g. `service: 'gmail'`)
> carry their own host/port and **win over** anything passed alongside them. The
> provider therefore treats `MAIL_HOST` as the source of truth and only falls back to
> `MAIL_SERVICE` when no host is set. This is covered by a test.

`MAIL_AUTH_TYPE=password` uses a Gmail **App Password**
(Google Account → Security → 2-Step Verification → App passwords). `oauth2` reuses
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`, which requires
the OAuth client to be **published** — a client in *Testing* mode issues refresh tokens
that expire after 7 days, which is why the current token in `.env` no longer works.

Check the credentials without sending anything:

```bash
curl -X POST localhost:3000/api/email/verify
# {"verified":true,"host":"smtp.gmail.com","user":"you@gmail.com"}
```

If it fails you get the actual SMTP reason (bad credentials, blocked port, TLS), not a
generic 500.

### Templates — where to edit your copy

All copy is in **`src/modules/template/templates/mail-templates.ts`**: three roles ×
two variants (`initial`, `follow_up`). Templates are plain Handlebars strings using
only these variables:

| Variable | Example |
|---|---|
| `{{name}}` | `Asha Rao` |
| `{{firstName}}` | `Asha` (first token of `name`) |
| `{{company}}` | `Acme` |
| `{{role}}` | `FRONTEND` |
| `{{roleLabel}}` | `Frontend` |

A test asserts that no template uses a placeholder outside that list, so a typo like
`{{compnay}}` fails the build instead of silently sending a blank.

The `follow_up` variant is already selectable (`?type=follow_up`) but nothing sends it
automatically until Phase 4.

---

## 6. API reference

Base URL: `http://localhost:3000/api` (`API_PREFIX`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/campaign/connect-sheet` | Register a spreadsheet URL/id for this process |
| `GET` | `/campaign/validate` | Row-level validation report |
| `GET` | `/campaign/preview` | Counts + rendered emails, **sends nothing** |
| `POST` | `/campaign/send` | Dry-run by default; `?dryRun=false` sends for real |
| `POST` | `/email/verify` | Check SMTP credentials |

### `POST /campaign/connect-sheet`

```bash
curl -X POST localhost:3000/api/campaign/connect-sheet \
  -H 'Content-Type: application/json' \
  -d '{"spreadsheetUrl":"https://docs.google.com/spreadsheets/d/1X8K4.../edit"}'
```

Accepts a full URL or a bare id; `sheetName` is optional. Verifies the tab exists
before saving the connection. The connection lives in memory for the process lifetime —
there is no database — so a restart falls back to `GOOGLE_SPREADSHEET_ID` / `SHEET_NAME`.

### `GET /campaign/validate`

```json
{
  "connection": { "spreadsheetId": "1X8K4...", "sheetName": "Candidates", "driver": "apps_script" },
  "total": 55, "valid": 53, "invalid": 2,
  "errors": [
    { "row": 12, "field": "email", "message": "email is not a valid email address" },
    { "row": 31, "field": "role", "message": "role must be one of: FRONTEND, BACKEND, FULL_STACK" }
  ]
}
```

`row` is the real Google Sheets row number. Rules live as class-validator decorators on
`Candidate`, so the API and the send path can never disagree about what is valid.

### `GET /campaign/preview`

| Query | Default | Meaning |
|---|---|---|
| `limit` | `5` | How many rendered emails to return (1–50) |
| `role` | all | `FRONTEND` / `BACKEND` / `FULL_STACK` |
| `type` | `initial` | `initial` or `follow_up` |

```bash
curl 'localhost:3000/api/campaign/preview?limit=2&role=FRONTEND'
```

Returns `counts` (total/pending/processing/sent/failed), how many rows are `eligible`
(valid **and** `PENDING`), and the rendered `subject` + `body` per candidate. **This is
the endpoint to read before every real send.**

### `POST /campaign/send`

| Query | Default | Meaning |
|---|---|---|
| `dryRun` | `SEND_DEFAULT_DRY_RUN` (true) | `false` sends real email |
| `limit` | `50` | Max rows to process |
| `role`, `type` | all / `initial` | Same as preview |

A row is **eligible** when it passes validation *and* is still `PENDING`. Rows already
`SENT`/`FAILED`/`PROCESSING` are skipped, which is what stops a second call from
re-sending a batch.

```bash
# 1. Dry run — renders everything, no provider call, no sheet write
curl -X POST 'localhost:3000/api/campaign/send?limit=3'

# 2. Real send, one recipient only
curl -X POST 'localhost:3000/api/campaign/send?dryRun=false&limit=1'
```

Safety properties, all covered by tests:

- A real send is never the default. `?dryRun=maybe` is **rejected with 400** rather than
  being coerced to `false`.
- Rows are processed strictly sequentially with `EMAIL_DELAY_MS` between sends (never
  `Promise.all`).
- One row's failure cannot stop the batch: the error is written to that row and the loop
  continues.
- Each outcome is written to the sheet immediately — `SENT` + `sent_at` + `message_id`,
  or `FAILED` + `error`, with `attempts` incremented.
- `limit=1` is the intended way to prove the pipeline before a batch.

Response shape:

```json
{
  "dryRun": false, "eligible": 2, "processed": 2, "sent": 2, "failed": 0,
  "results": [
    { "row": 2, "email": "asha@example.com", "status": "SENT", "messageId": "<...@domain>" }
  ]
}
```

---

## 7. Configuration reference

Everything is read in `src/config`; see `.env.example` for a copyable template.

| Variable | Default | Used by |
|---|---|---|
| `NODE_ENV`, `PORT`, `API_PREFIX` | `development`, `3000`, `api` | Bootstrap |
| `SHEET_NAME` | `Candidates` | Tab to operate on |
| `GOOGLE_SHEET_DRIVER` | `apps_script` | Driver selection |
| `GOOGLE_APPS_SCRIPT_URL` | – | Apps Script bridge URL |
| `GOOGLE_SHEET_TIMEOUT_MS` | `15000` | Sheet request timeout |
| `GOOGLE_SPREADSHEET_ID` | – | Default spreadsheet |
| `GOOGLE_SERVICE_ACCOUNT_*` | – | `service_account` driver only |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_SECURE` | – / `587` / `false` | SMTP connection |
| `MAIL_SERVICE` | `gmail` | Fallback preset when no host |
| `MAIL_AUTH_TYPE` | `password` | `password` or `oauth2` |
| `MAIL_FROM` / `MAIL_USER` / `MAIL_PASSWORD` | – | Sender + credentials |
| `SEND_DEFAULT_DRY_RUN` | `true` | Fallback when `?dryRun` is absent |
| `EMAIL_DELAY_MS` | `2000` | Gap between sends |
| `EMAIL_MAX_RETRIES` | `2` | Phase 3 |
| `STALE_PROCESSING_THRESHOLD_MINUTES` | `30` | Phase 4 |
| `CRON_*` | – | Phase 4 (not read yet) |

---

## 8. Running and testing

```bash
npm install
npm run start:dev          # watch mode on :3000
npm run build && npm run start:prod

npm run lint               # eslint --fix
npm test                   # 61 unit tests
npm run test:e2e           # 12 e2e tests
```

Test coverage is deliberately concentrated on the risky logic:

- `template.service.spec.ts` — every role × variant renders, placeholders are real,
  `firstName` derivation, no leaked `{{ }}`.
- `campaign.service.spec.ts` — eligibility filtering, dry-run never calls the provider,
  one row failing does not stop the batch, write-back payloads, per-row isolation.
- `google-sheet.service.spec.ts` — row mapping, required-column detection, and that a
  targeted write only touches the patched span.
- `nodemailer.provider.spec.ts` — **real SMTP delivery** against a throwaway local
  server, plus the `MAIL_HOST`-beats-`service` regression test.
- `test/campaign.e2e-spec.ts` — the HTTP contract, including `?dryRun=maybe` → 400.

---

## 9. What Phase 3 will add (not built yet)

Do not rely on any of this today:

- `PROCESSING` state transition as a pre-send lock.
- The in-memory `isCampaignRunning` lock (`409 Conflict` on a concurrent run).
- Retryable vs non-retryable error classification honouring `EMAIL_MAX_RETRIES`.
- `campaign_id` stamping (`campaign-YYYYMMDD-NNN`).
- `GET /campaign/status` as a standalone endpoint (counts are currently inside
  `/campaign/preview`).
- Asynchronous, non-blocking `send` (it is currently synchronous — a 60-row batch will
  hold the HTTP request open for ~2 minutes at `EMAIL_DELAY_MS=2000`).

**Known limitation until then:** if the process dies mid-send, a row can stay `PENDING`
after its email already went out, so a later run would send it again. Phase 3's
`PROCESSING` guard closes this window.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 ... GOOGLE_APPS_SCRIPT_URL is not configured` | Env var missing, or `GOOGLE_SHEET_DRIVER` is not `apps_script`. |
| `503 ... Apps Script web app reported an error: Range ... not found` | The deployment is serving an old script. Deploy → Manage deployments → Edit → New version. |
| `Tab "Candidates" not found` | `SHEET_NAME` does not match the tab, or the script's bound sheet is a different file. |
| `missing required column(s): name, email` | Header row is not row 1, or headers are spelled differently. |
| `Invalid login: 535-5.7.8` | `MAIL_PASSWORD` must be a 16-char App Password, not the account password. |
| `preview` returns 0 eligible | Rows are not `PENDING` (already sent) or fail validation — check `/campaign/validate`. |
| Emails went to the wrong server | `MAIL_SERVICE` preset is active because `MAIL_HOST` is empty. Set `MAIL_HOST` explicitly. |
