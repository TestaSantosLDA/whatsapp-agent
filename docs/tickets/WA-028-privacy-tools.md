# WA-028: Privacy tools: export, clear profile, delete

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M5        | WA-022     |     |

## Why

Under GDPR the client (controller) must answer access, objection and erasure requests, and the service (processor) must give it the means. It also makes the product easier to sell.

## Scope

- Per customer, for admins:
  - **Export:** everything held about the person (record, profile, messages, files, leads, quotes, emails) as one ZIP with JSON and the files.
  - **Clear profile:** deletes the profile and stops profiling that customer; history stays.
  - **Delete customer:** removes conversations, messages, files, profile, notes and emails; leads and quotes are anonymised so counts and stats stay right. Asks for confirmation by typing the name.
- **Requests from WhatsApp:** "apague os meus dados" / "delete my data" makes the agent confirm and open a privacy request in the dashboard for an admin to approve; the customer is told when it is done.
- **Retention:** contacts inactive for N months (per client, default 24) are deleted by a scheduled job, with a list shown to admins a week before.
- **Audit log:** who exported, cleared or deleted what, and when (kept without personal content).

## Acceptance criteria

- [x] Export of a demo customer contains all their data; after delete, nothing with their phone or name remains in any table (test over the whole schema).
- [x] A WhatsApp deletion request appears in the dashboard and, once approved, is carried out and confirmed to the customer.

## Out of scope

Data held in Shopify, the ERP or email inboxes (the client handles those), legal documents (DPA template: to be drafted with a lawyer).

## Implementation (2026-10-23)

- **Handlers** ([privacy/registry.ts](../../apps/api/src/privacy/registry.ts), [privacy/handlers.ts](../../apps/api/src/privacy/handlers.ts)): every table with customer data has a `PersonalDataHandler` (`name`, `tables`, `order`, `export`, `erase` → `{ deleted }` or `{ anonymised }`, optional `clearProfile`). Today: contacts, conversations, messages (with media references), leads (anonymised: keep type, branch, status, dates and `request_type`/`business_line`/`area_m2`), lead notes (deleted) and lead events (deleted: their data may hold text about the person), outbox emails (by conversation, phone in subject/body or recipient email), agent_runs (kept for costs without conversation, tool inputs/outputs and error text) and privacy_requests (kept, unlinked). `PrivacyService.registerPersonalData()` adds one at runtime. The guard test introspects the drizzle schema and fails for any table with a `contact_id`/`conversation_id`/`customer_id`/`lead_id` column, or a foreign key (followed transitively) to contacts, conversations, customers, leads or another such table, that no handler covers.
- **Customer = contact** for now; `SubjectResolver` (constructor option) lets WA-027 map a customer record to all its contacts.
- **Export:** `GET …/privacy/customers/:id/export` streams a ZIP (fflate) with `data.json` (one key per handler) and `media/<handler>/…` for files handlers return. Inbound media are only WhatsApp media ids today, so the ZIP has no media files yet; listed under `messages.media`.
- **Clear profile:** runs the handlers' `clearProfile` (none yet; WA-027's profile store) and sets `contacts.profiling_opt_out`.
- **Delete:** typed confirmation (name in any case, or the number with or without country code); all erases in one transaction, counts per table, audited.
- **Requests from WhatsApp:** core tool `request_data_deletion` (`delete | export | clear_profile`, `confirmed: true`) opens a `privacy_requests` row (one pending per type and contact); prompt section "Personal data". Admin approves in Privacidade → Pedidos (delete needs the typed confirmation); the action runs and the customer gets a WhatsApp message (the delete confirmation is sent through the channel without storing it, so no new trace). Rejecting tells the customer a colleague will contact them. An export request is "marked as sent" after the admin downloads the ZIP; sending the ZIP to the customer is manual.
- **Retention:** `privacy.retention_months` (default 24) in client config; `POST /jobs/privacy-retention` (JOBS_SECRET, `?client=`), daily Cloud Scheduler job in [deploy.md](../deploy.md); last activity = latest conversation activity or contact creation, taken over every number of the customer record: one active number keeps the whole record, and an idle record is deleted whole (the preview uses the same rule). Ids that are not UUIDs answer 404. `GET …/privacy/retention` lists whom it deletes within 7 days.
- **Audit:** `privacy_audit` (member id, action, sha256 of the contact id, request id, counts, time). No personal content.
- **Dashboard:** lazy feature `features/privacy` (admins only, nav "Privacidade"): customer search → export / clear profile / delete with typed confirmation; pending requests; retention preview; audit log.
- **Schema:** `privacy_requests`, `privacy_audit`, `contacts.profiling_opt_out`, `agent_runs.conversation_id` now nullable.
- **Tests:** `apps/api/src/privacy/privacy.test.ts` (schema guard, export completeness, delete leaves the phone/name/email in no text/text[]/jsonb column of any table, anonymised leads keep counts, other customers untouched, admin-only, request flow from a scripted Claude conversation with WhatsApp confirmation, duplicate request and rejection, retention job and preview); `privacy.page.spec.ts` (typed confirmation, approve request).
- **Screenshots:** `/mnt/project-files/m5/wa028-privacy-*.png` (home, delete confirmation, requests, retention, audit; phone and desktop).

### Open items

- Media files in the export once media are stored (WA-030); the messages handler then returns them as `files`.
- WA-027: register the profile handler with `clearProfile`, pass a `SubjectResolver` for customer records, honour `profiling_opt_out`.
- WA-023/024/025/026: add handlers for new tables (inbox fields on existing tables need no handler unless they hold free text about the person outside rows already erased).
- Sending the export ZIP to the customer is manual (no email/WhatsApp document delivery).
- Retention deletes at most 500 contacts per client per run.
