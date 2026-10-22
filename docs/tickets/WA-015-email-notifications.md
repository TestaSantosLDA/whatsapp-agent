# WA-015: Email notifications and Mailer

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M3        | WA-014     |     |

## Why

Branch staff must hear about a lead or handoff within minutes, in the tool they already use.

## Scope

- `Mailer` interface with `MockMailer` (writes to `outbox`, shown in the back-office panel) and `ResendMailer`.
- Templates (pt-PT, with English customer messages quoted as-is): new lead, handoff request, order draft.
- Each email includes the customer's name and phone, a summary, the key fields, and a link to the WhatsApp conversation (`https://wa.me/<phone>`).
- Recipients come from the routed branch in client config.

## Acceptance criteria

- [ ] In demo mode, every lead and handoff produces one email visible in the panel.
- [ ] With Resend configured, the email arrives and renders on Gmail and Outlook.
- [ ] A failed send is retried and never blocks the reply to the customer.
