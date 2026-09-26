# Product Requirements Document (PRD)
## Project: MailOps

**Version:** 1.0 (V1 — No-DB Edition)
**Owner:** Personal project
**Status:** Draft for implementation

---

## 1. Overview

MailOps is a personal-use NestJS backend that automates sending personalized, role-based bulk outreach emails (50–60 per batch) to HR contacts, using a **Google Sheet as the single source of truth** for both data and state — with no traditional database.

The system reads candidate/HR records from a connected Google Sheet, generates a personalized email using a template selected by the person's role (Frontend / Backend / Full Stack), sends it via the Gmail API, and writes the result (status, timestamp, message ID, errors) back into the same Sheet. It also supports scheduled sending and automated follow-ups, controlled by an application-level cron job.

## 2. Problem Statement

Manually sending 50–60 personalized outreach emails to different HRs, tracking who was contacted, with what template, and when to follow up, is tedious and error-prone. A lightweight, DB-free automation tool driven by a spreadsheet the user already knows how to edit solves this without the operational overhead of provisioning and maintaining a database.

## 3. Goals

- Send personalized bulk emails (50–60/batch) based on a Google Sheet.
- Select an email template automatically based on the `Role` column (Frontend / Backend / Full Stack).
- Persist all state (sent/pending/failed, timestamps, message IDs, errors) inside the Google Sheet — no database.
- Prevent duplicate sends and handle partial failures gracefully.
- Support scheduled sending and configurable automated follow-ups.
- Keep the system safe for a single personal user, safe to restart, and simple to operate.

## 4. Non-Goals (V1)

- No multi-user support or authentication system for external users.
- No queue infrastructure (BullMQ/Redis) — deferred to V2.
- No horizontally scaled/multi-instance deployment guarantees.
- No built-in unsubscribe management system beyond a manual opt-out flag (future consideration).
- No support for arbitrary email providers beyond an abstracted interface (Gmail API is the only V1 implementation).

## 5. Users

- **Primary user:** The project owner, operating the tool for personal job-outreach campaigns.
- **Interaction surface:** REST API (via Postman/curl or a thin frontend later) + Google Sheet as the operational UI for data entry.

## 6. Source of Truth & State Model

Google Sheets is the **only persistent store**. The core architectural principle:

> Google Sheet stores business state; NestJS handles business logic; the email provider handles delivery.

### 6.1 Sheet Columns (V1)

| Column | Purpose |
|---|---|
| `name` | Recipient name |
| `email` | Recipient email |
| `company` | Company name |
| `role` | `FRONTEND` / `BACKEND` / `FULL_STACK` |
| `status` | `PENDING` / `PROCESSING` / `SENT` / `FAILED` |
| `sent_at` | Timestamp of successful send |
| `message_id` | Provider message ID |
| `error` | Failure reason |
| `attempts` | Retry count |
| `campaign_id` | Identifier for the batch (e.g. `20260927-001`) |
| `follow_up_enabled` | `YES` / `NO` |
| `follow_up_days` | Days after `sent_at` to trigger follow-up |
| `follow_up_status` | `NOT_SCHEDULED` / `SCHEDULED` / `PROCESSING` / `SENT` / `FAILED` |
| `follow_up_sent_at` | Timestamp of follow-up send |
| `follow_up_message_id` | Provider message ID for follow-up |
| `processing_started_at` | Used to detect and recover stale `PROCESSING` rows |

### 6.2 State Machines

**Initial email:**
`PENDING → PROCESSING → SENT`
`PENDING → PROCESSING → FAILED`

**Follow-up email:**
`NOT_SCHEDULED → SCHEDULED → PROCESSING → SENT`
`... → PROCESSING → FAILED`

A `PROCESSING` row older than a configurable threshold (e.g. 30 minutes) is treated as stale and eligible for retry, protecting against crashes mid-send.

## 7. Functional Requirements

### 7.1 Google Sheet Integration
- Connect to a Sheet via spreadsheet ID/URL (config-driven for personal use).
- Read all rows, map to typed candidate records.
- Validate rows (valid email, valid role enum, required name/company) before allowing a send.
- Write back status, timestamps, message IDs, and errors per row (targeted cell/row updates, not full-sheet overwrites).

### 7.2 Role-Based Templates
- Templates are defined in code (not in the Sheet), one set per role, with `initial` and `follow_up` variants.
- Template engine (Handlebars) supports variable interpolation: `{{name}}`, `{{company}}`, `{{role}}`, etc.
- A **preview/dry-run** endpoint generates rendered subject/body per candidate without sending, to catch template errors before a real batch send.

### 7.3 Campaign Execution
- `POST /campaign/send` triggers processing of all eligible `PENDING` rows.
- Emails are sent sequentially with a configurable delay (`EMAIL_DELAY_MS`) — never in parallel via `Promise.all`.
- Each candidate is processed independently: one failure must not block the rest of the batch.
- An in-memory lock prevents two campaign runs from executing concurrently (acceptable for single-instance personal use).
- Every row transitions through `PROCESSING` before `SENT`/`FAILED` so a crash mid-run is recoverable.

### 7.4 Scheduling (Cron)
- A cron job, controlled entirely by environment configuration (`CRON_ENABLED`, `CRON_HOUR`, `CRON_MINUTE`, `CRON_TIMEZONE`), wakes up once daily.
- When `CRON_ENABLED=false`, no cron job is registered at all (not merely skipped at runtime).
- On each run, the cron:
  1. Processes any eligible `PENDING` initial emails.
  2. Processes any eligible follow-ups.
- Scheduling policy (when to send) lives in the application/config layer, **not** in the Sheet.

### 7.5 Follow-ups
- Per-row opt-in via `follow_up_enabled` + `follow_up_days`.
- Follow-up due time is computed dynamically as `sent_at + follow_up_days`, not stored as a fixed timestamp.
- Follow-up uses a role-specific `follow-up` template variant.
- Follow-ups reuse the same `PROCESSING` guard and independent per-row error handling as initial sends.

### 7.6 Duplicate & Failure Protection
- Status transitions (`PENDING → PROCESSING`) act as an application-level lock before any send is attempted.
- Errors are classified as retryable (timeout, rate limit, network) vs non-retryable (invalid email, auth error); only retryable errors are retried, up to `EMAIL_MAX_RETRIES`.
- Stale `PROCESSING` rows (server crashed mid-send) are detected via `processing_started_at` and become eligible for retry.

## 8. API Surface (V1)

| Endpoint | Purpose |
|---|---|
| `POST /campaign/connect-sheet` | Register the spreadsheet ID/URL to operate on |
| `GET /campaign/validate` | Validate Sheet rows, return valid/invalid counts and row-level errors |
| `GET /campaign/preview` | Return counts (total/pending/sent/failed) and optionally rendered email previews |
| `POST /campaign/send?dryRun=true|false` | Trigger sending of eligible pending emails (dry-run logs only) |
| `GET /campaign/status` | Return current counts by status, including follow-up status |

## 9. Non-Functional Requirements

- **Resilience:** Recoverable after a process crash/restart without data loss, using Sheet-persisted state.
- **Rate-safety:** Sequential sending with configurable delay to respect Gmail sending limits and avoid spam-like bursts.
- **Simplicity:** No database, no external queue/cache infrastructure in V1.
- **Configurability:** Cron timing/enablement, email delay, and retry limits are environment-driven, not hardcoded.
- **Observability (baseline):** Structured logs per candidate per send attempt (success/failure/reason).
- **Security:** Google OAuth credentials and Gmail tokens stored only in environment/config, never in the Sheet or source code.

## 10. Environment Configuration (V1)

```
NODE_ENV=development
PORT=3000

CRON_ENABLED=true
CRON_HOUR=8
CRON_MINUTE=0
CRON_TIMEZONE=Asia/Kolkata

EMAIL_DELAY_MS=2000
EMAIL_MAX_RETRIES=2

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_SPREADSHEET_ID=

GMAIL_USER=
```

## 11. Tech Stack (V1)

NestJS, TypeScript, Google Sheets API, Gmail API (OAuth), Handlebars, class-validator, `@nestjs/config`, `@nestjs/schedule`. Explicitly **no** PostgreSQL/MongoDB/Redis/BullMQ in V1.

## 12. Success Metrics

- 50–60 emails can be sent per run with zero duplicate sends across repeated/overlapping trigger attempts.
- A mid-batch crash and restart results in correct resumption (no duplicates, no skipped pending rows).
- Template misconfiguration is caught via preview/dry-run before any real send in ≥95% of cases.
- Follow-ups fire within the same day they become due, without manual intervention.

## 13. Risks & Constraints

- Google Sheets API has rate limits; frequent polling/writes must be batched/minimized.
- Sending volume and behavior must respect the email provider's (Gmail) terms of service and sending limits — outreach at this pattern can trigger provider throttling if templates are too similar or volume increases.
- In-memory locking only protects a single running instance; not safe if scaled horizontally (acceptable for V1's personal-use scope).
- No deliverability/unsubscribe compliance system in V1 beyond a manual flag — a risk if usage grows beyond personal scope.

## 14. Future Scope (V2, Out of Scope for V1)

- BullMQ + Redis-based worker queue for sending and follow-up processing.
- Multiple email provider support (SES, Resend, SendGrid) behind the existing `EmailProvider` abstraction.
- Webhook-based delivery/open tracking.
- Structured campaign management UI.
- Distributed locking / multi-instance safe duplicate prevention.
- Formal unsubscribe/opt-out compliance workflow.