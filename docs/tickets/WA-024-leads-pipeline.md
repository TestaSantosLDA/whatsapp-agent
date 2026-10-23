# WA-024: Leads pipeline with owners and no-reply alerts

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| todo   | M5        | WA-022, WA-014 |     |

## Why

The costliest failure for a sales team is a good quote request nobody answered. Every lead needs an owner and a clock.

## Scope

- **Leads list:** leads, order drafts and handoffs, filtered by branch, type, status and owner; search by name, phone or product; CSV export.
- **Lead page:** fields, summary, attachments, linked conversation, notes, activity history.
- **Status:** `new` → `contacted` → `quoted` → `won` / `lost` (lost asks for a reason from a short list). Changes are one tap.
- **Owner:** set automatically by branch rules (round robin among the branch's sales members, or a named default), changeable by hand.
- **No-reply alerts:** if a lead is still `new` after the client's response time (working hours only, using branch hours), the owner gets a reminder; after 24 working hours the branch's admins get one too. A scheduled job (Cloud Scheduler, WA-020) runs the check.

## Acceptance criteria

- [ ] A lead saved by the agent appears with an owner; left untouched past the response time, the owner receives a reminder email, and later the admin does.
- [ ] Hours outside opening times do not count towards the response time (tests with fixed clocks).

## Out of scope

Forecasting, deal values per stage, a full CRM. Syncing to an external CRM comes later as another LeadSink.
