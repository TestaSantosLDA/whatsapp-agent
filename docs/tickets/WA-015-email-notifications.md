# WA-015: Email notifications and Mailer

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M3        | WA-014     |     |

## Why

Branch staff must hear about a lead or handoff within minutes, in the tool they already use.

## Scope

- `Mailer` interface with `MockMailer` (writes to `outbox`, shown in the back-office panel) and `ResendMailer`.
- Templates (pt-PT, with English customer messages quoted as-is): new lead, handoff request, order draft.
- Each email includes the customer's name and phone, a summary, the key fields, and a link to the WhatsApp conversation (`https://wa.me/<phone>`).
- Recipients come from the routed branch in client config.

## Acceptance criteria

- [x] In demo mode, every lead and handoff produces one email visible in the panel (an `outbox` row with the conversation id, published as an `email` event; the panel UI is WA-018).
- [ ] With Resend configured, the email arrives and renders on Gmail and Outlook. The request is covered by tests; needs a live check with a verified sender domain.
- [x] A failed send is retried and never blocks the reply to the customer.

## Implementation

- `apps/api/src/mail/mailer.ts`: `Mailer { send(email), flush() }`. `OutboxMailer` writes every email to `outbox` and publishes it to the back-office; with no transport (demo mode, the MockMailer) it sets `sentAt` at once and stops there. `ResendMailer` is the outbox plus `ResendTransport` (`POST https://api.resend.com/emails`, `Idempotency-Key` = outbox row id, so a retry never sends twice).
- Delivery runs in the background (`apps/api/src/services/background.ts`, `BackgroundTasks`): the turn only waits for the outbox insert. Retries after 2 s, 10 s and 60 s; after the last failure the error is stored on the row, published and logged. `send()` never throws, even if the outbox insert fails. `flush()` waits for pending deliveries (tests). An update to a row is published again with the same id, so the panel should replace the email it shows.
- The mailer is picked from the environment: `RESEND_API_KEY` set → Resend, else outbox only. The sender is `mail.from` (and optional `mail.reply_to`) in the client config.
- Templates (`apps/api/src/mail/templates.ts`), pt-PT, plain text plus simple inline-styled HTML (one table, no images, no CSS classes): new lead, handoff, order draft. Each has the customer name, phone, the key fields, the summary (customer words in other languages quoted as written, per the tool descriptions) and `https://wa.me/<phone>`.
- Recipients: the routed branch's `lead_emails`, else its `email`. With neither, the outbox row is written with an error ("no recipients configured") so the gap shows in the panel.

## Open items

- Jular's recipients are unknown: `jular.yaml` uses `<branch>@example.invalid` placeholders with TODOs (Camarate's `lojaonline@jular.pt` is not used until Jular confirms who receives leads).
- `mail.from` is a placeholder; Resend needs a sender on a verified domain.
- Retries live in memory: an email still retrying when the process stops keeps its row with neither `sentAt` nor `error`. A periodic job that resends such rows can come with WA-020 (Cloud Run).
- The outbox stores the plain-text body only.
