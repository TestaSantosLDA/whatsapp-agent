# WA-028: Privacy tools: export, clear profile, delete

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M5        | WA-022     |     |

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

- [ ] Export of a demo customer contains all their data; after delete, nothing with their phone or name remains in any table (test over the whole schema).
- [ ] A WhatsApp deletion request appears in the dashboard and, once approved, is carried out and confirmed to the customer.

## Out of scope

Data held in Shopify, the ERP or email inboxes (the client handles those), legal documents (DPA template: to be drafted with a lawyer).
