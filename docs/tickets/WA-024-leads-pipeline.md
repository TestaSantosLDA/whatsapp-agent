# WA-024: Leads pipeline with owners and no-reply alerts

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M5        | WA-022, WA-014 |     |

## Why

The costliest failure for a sales team is a good quote request nobody answered. Every lead needs an owner and a clock.

## Scope

- **Leads list:** leads, order drafts and handoffs, filtered by branch, type, status and owner; search by name, phone or product; CSV export.
- **Lead page:** fields, summary, attachments, linked conversation, notes, activity history.
- **Status:** `new` → `contacted` → `quoted` → `won` / `lost` (lost asks for a reason from a short list). Changes are one tap.
- **Owner:** set automatically by branch rules (round robin among the branch's sales members, or a named default), changeable by hand.
- **No-reply alerts:** if a lead is still `new` after the client's response time (working hours only, using branch hours), the owner gets a reminder; after 24 working hours the branch's admins get one too. A scheduled job (Cloud Scheduler, WA-020) runs the check.

## Acceptance criteria

- [x] A lead saved by the agent appears with an owner; left untouched past the response time, the owner receives a reminder email, and later the admin does.
- [x] Hours outside opening times do not count towards the response time (tests with fixed clocks).

## Out of scope

Forecasting, deal values per stage, a full CRM. Syncing to an external CRM comes later as another LeadSink.

## Implementation (2026-10-23)

**Data.** `leads` gains `status` (`new|contacted|quoted|won|lost`), `lost_reason`, `owner_member_id`, `contacted_at` (first time it left `new`), `quoted_at`, `closed_at`, `status_changed_at`, and the reminder bookkeeping `owner_reminded_at` / `admin_reminded_at`. New tables `lead_notes` and `lead_events` (`created`, `status`, `owner`, `note`, `reminder_owner`, `reminder_admin`, with the actor and a JSON `data`). Shared types and schemas in [packages/shared/src/leads.ts](../../packages/shared/src/leads.ts); lost reasons are a fixed list (price, competitor, no reply, stock/lead time, out of area, gave up, other) so WA-029 can count them. `BackofficeLead` gains optional `ownerId` / `ownerName`.

**Owner.** [leads/owner.ts](../../apps/api/src/leads/owner.ts): `LeadOwnerPolicy`, used in one place, `DbLeadSink.insert`, so `save_lead`, order drafts and handoffs all get an owner. `BranchRoundRobinPolicy`: the branch's sales members, else its admins, else nobody; the next one is the candidate whose latest lead is oldest (stateless, survives restarts and team changes; a new member is next). A failing lookup stores the lead without an owner. A named default owner per client is left for later (settings).

**API** (`/api/admin/clients/:clientId/leads`, [admin/leads](../../apps/api/src/admin/leads/)): list with `branch`, `type`, `status`, `owner` (`me`, `none`, id), `q` (name, phone digits, products, order lines, summary), `limit`/`offset`; detail (fields, summary, attachment metadata, conversation id, contact, notes, events newest first, possible owners); `PATCH /:id/status` (`lost` needs a `lostReason`, optional note recorded with the change); `PATCH /:id/owner` (members of the lead's branch or admins); `POST /:id/notes`; `GET /export.csv` (same filters, UTF-8 BOM, `;`, CRLF, quoted cells, formula injection neutralised, PT phones as `912 345 678`, at most 5000 rows). Sales members see their branches only (`branchFilter` / `assertBranch`). `LeadsService.setStatus(client, lead, { status, actorMemberId })` is public for WA-025 (mark `quoted` when a quote is sent).

**Reminders.** `POST /jobs/lead-reminders` (JOBS_SECRET) runs [leads/reminders.ts](../../apps/api/src/leads/reminders.ts): leads still `new` (last 60 days) past `lead.response_time_hours` (default 8) in working hours of their branch email the owner once (no owner: the branch admins, else the branch's lead recipients); after 24 working hours, the branch's admins once (none for the branch: every admin). Each reminder is claimed with a conditional `UPDATE` before the email, so overlapping runs never double-send. `workingHoursBetween(branch, from, to, tz)` in [agent/hours.ts](../../apps/api/src/agent/hours.ts) handles lunch breaks, closed days and DST. Cloud Scheduler job `wa-lead-reminders` (every 15 minutes) documented in [deploy.md](../deploy.md) step 13.

**Dashboard** (`apps/admin/src/app/features/leads`): list with cards on phones and a table from 900 px, search, type / branch / owner selects and status chips; one-tap next-step chips on each lead (lost asks for the reason with one more tap); CSV export; lead page with status chips, owner picker, request details, attachments, WhatsApp link, "Abrir a conversa" (links to `/inbox/<conversationId>`), notes and activity. Feature styles are component styles (each under the 4 kB budget) rather than additions to the global sheet, to keep `styles.css` merge-free.

**Tests.** API: round robin and fallbacks, scoping, filters and search, status transitions and events, owner changes, notes, CSV format, working-hours maths with fixed clocks (Friday 17:30 + 8 h → Monday 17:30; with Saturday hours → Monday 12:30; lunch, closed days, both DST changes), reminder timing and idempotency (including two concurrent runs), the jobs route, and an end-to-end turn where the agent saves a lead and the owner, then the admin, are reminded. Dashboard: list, filters, one-tap status and lost reason, lead page, owner change, notes.

**Screenshots** (`/mnt/project-files/m5/`): `admin-leads-mobile.png`, `admin-leads-mobile-full.png`, `admin-leads-mobile-lost-reason.png`, `admin-leads-mobile-sales.png`, `admin-leads-desktop.png`, `admin-lead-mobile.png`, `admin-lead-mobile-full.png`, `admin-lead-desktop.png`.

**Open items.**

- Named default owner per client/branch (settings) before the round robin.
- WA-023 should serve `/inbox/:conversationId` (the lead page links there).
- Reminder emails go to people, not the conversation thread; replying to them does not update the lead.
