# MailOps — Phase-Wise Implementation Plan

Companion document to `PRD.md`. Five phases, each independently runnable/testable, building up from raw Sheet I/O to a fully scheduled, follow-up-capable system — no database at any stage.

---

## Phase 1 — Project Foundation & Google Sheets Integration

**Goal:** A working NestJS skeleton that can authenticate to Google, read the target Sheet, map rows to typed objects, and validate them. No email sending yet.

**Modules touched:** `config`, `google-sheet`

**Tasks:**
- Scaffold NestJS project; set up `@nestjs/config` with a typed `configuration.ts`.
- Set up Google OAuth (client ID/secret/redirect URI) and Sheets API client.
- `GoogleSheetService`:
  - `getCandidates()` — read all rows, map to a `Candidate` type (name, email, company, role, status, etc.).
  - `updateRow(rowNumber, patch)` — targeted cell/row update (never full-sheet overwrite).
- `POST /campaign/connect-sheet` — accept a Sheet URL/ID, extract `spreadsheetId`, persist to config for this run.
- Validation layer using `class-validator`:
  - `email` is a valid email.
  - `role` is one of `FRONTEND` / `BACKEND` / `FULL_STACK`.
  - `name`, `company` required.
- `GET /campaign/validate` — returns `{ valid, invalid, errors: [{ row, field, message }] }`.

**Exit criteria:** Can connect a real Sheet, fetch all rows, and get an accurate valid/invalid report with row-level error messages.

---

## Phase 2 — Template Engine & Email Sending Core

**Goal:** Generate personalized emails per role and send a single email successfully via Gmail, with a safe dry-run mode.

**Modules touched:** `template`, `email`

**Tasks:**
- `TemplateService` with per-role templates (`frontend`, `backend`, `full-stack`), each with `initial` and `follow-up` variants, using Handlebars for `{{name}}`, `{{company}}`, `{{role}}` interpolation.
- `getTemplate(role, type)` returns `{ subject, body }`.
- `EmailProvider` interface (`sendEmail(options): Promise<SendEmailResult>`) and a `GmailProvider` implementation using the Gmail API (OAuth), returning a provider `messageId`.
- `EmailService` wraps the provider, exposing a single `send()` used by the rest of the app (provider-agnostic).
- Dry-run support: `POST /campaign/send?dryRun=true` renders and logs every eligible email without calling the provider.
- `GET /campaign/preview` — returns rendered subject/body samples per candidate for manual review before a real send.

**Exit criteria:** Can render a correct, role-specific email for a sample candidate, dry-run a full batch and inspect output, and successfully send one real email end-to-end via Gmail API with a returned message ID.

---

## Phase 3 — Campaign Orchestration, State Machine & Failure Handling

**Goal:** Turn single-email sending into a safe, resumable batch campaign against the Sheet, with correct state transitions and independent per-row error handling.

**Modules touched:** `campaign`

**Tasks:**
- `CampaignService.processScheduledEmails()` (or `processCandidates()` for now):
  - Fetch `PENDING` rows.
  - For each: mark `PROCESSING` → generate template → send → mark `SENT` (with `message_id`, `sent_at`) or `FAILED` (with `error`), independently per row (no `try/catch` around the whole batch).
- Sequential processing with `EMAIL_DELAY_MS` delay between sends (no `Promise.all`).
- In-memory `isCampaignRunning` lock; `POST /campaign/send` returns `409 Conflict` if a run is already in progress.
- Error classification: `RETRYABLE_ERRORS` (timeout, rate limit, network) vs `NON_RETRYABLE_ERRORS` (invalid email, auth error); respect `EMAIL_MAX_RETRIES` for retryable ones via the `attempts` column.
- Campaign identifier: generate `campaign-YYYYMMDD-NNN` and stamp it on every row processed in that run (`campaign_id` column).
- `POST /campaign/send` — starts the batch asynchronously, returns immediately with `{ status: 'STARTED', total }`.
- `GET /campaign/status` — aggregate counts (`total`, `pending`, `processing`, `sent`, `failed`) read live from the Sheet.

**Exit criteria:** A full batch of 50–60 rows can be sent with one failing row (e.g. bad email) not blocking the rest; re-triggering `send` while one is running is rejected; killing the process mid-batch and restarting does not double-send already-`SENT` rows.

---

## Phase 4 — Scheduling & Follow-ups

**Goal:** Move from manually-triggered sends to a fully automated, cron-driven daily run that handles both initial emails and follow-ups, with cron behavior fully controlled by environment configuration.

**Modules touched:** `scheduler`, extensions to `campaign` and `google-sheet`

**Tasks:**
- `cron.config.ts`: parse `CRON_ENABLED`, `CRON_HOUR`, `CRON_MINUTE`, `CRON_TIMEZONE` from env.
- `SchedulerService` using `SchedulerRegistry` + `CronJob` (dynamic registration in `onModuleInit`):
  - If `CRON_ENABLED` is false, **no job is registered at all**.
  - If true, register a job at `CRON_HOUR:CRON_MINUTE` in `CRON_TIMEZONE` that calls `campaignService.processScheduledEmails()`.
- Extend the Sheet-derived candidate model with follow-up fields: `follow_up_enabled`, `follow_up_days`, `follow_up_status`, `follow_up_sent_at`, `follow_up_message_id`.
- `CampaignService.processFollowUps()`:
  - Filter rows where `status = SENT`, `follow_up_enabled = YES`, `follow_up_status = SCHEDULED` (or `NOT_SCHEDULED` → auto-promote to `SCHEDULED` once `sent_at` exists), and `sent_at + follow_up_days <= now`.
  - Render the `follow-up` template variant for the row's role.
  - Same `PROCESSING → SENT/FAILED` guard as initial emails, using follow-up-specific status columns.
- Stale-`PROCESSING` recovery: `processing_started_at` column; rows stuck in `PROCESSING` past a threshold (e.g. 30 min) are treated as recoverable and re-eligible.
- Single daily cron entry point runs both `processScheduledEmails()` (initial) and `processFollowUps()` in sequence.

**Exit criteria:** With `CRON_ENABLED=true` and a test time a minute in the future, the app automatically sends due initial emails and due follow-ups without any manual API call; with `CRON_ENABLED=false`, no cron fires at all; a row manually flipped to `follow_up_enabled=YES` with `follow_up_days=0` gets a follow-up on the very next cron tick.

---

## Phase 5 — Hardening, Observability & Polish

**Goal:** Make the tool safe and pleasant to operate as a real personal tool, and set up the seams for an eventual V2 (queues, multiple providers).

**Modules touched:** cross-cutting (`common`), all modules

**Tasks:**
- Structured logging per candidate/attempt (success, failure + reason, retry count) using Nest's `Logger`.
- Health check endpoint (`GET /health`) confirming Google Sheets and Gmail API connectivity.
- Graceful shutdown: ensure an in-flight campaign batch isn't abruptly killed mid-row (finish current row's Sheet write before exiting).
- Final review of `EmailProvider` abstraction to confirm it's ready for a second provider (SES/Resend) later without touching `CampaignService`.
- Basic API-level guard (simple API key header) since this is a personal tool exposed as a service.
- README covering: Sheet column reference, `.env` reference, how to run dry-run vs real send, how cron/follow-ups work.
- Manual/automated test pass: crash-recovery scenario, duplicate-prevention scenario, invalid-row validation scenario, follow-up timing scenario.

**Exit criteria:** The system can be handed off to "future you" with just the README and `.env` — no code reading required to operate a campaign safely.

---

## Phase Summary Table

| Phase | Focus | Key Deliverable |
|---|---|---|
| 1 | Sheets I/O & validation | Can read/validate real Sheet data |
| 2 | Templates & sending | Can dry-run and send one real email |
| 3 | Campaign orchestration | Can safely batch-send 50–60 emails, resumable |
| 4 | Scheduling & follow-ups | Fully automated daily cron incl. follow-ups |
| 5 | Hardening & polish | Production-safe personal tool + docs |