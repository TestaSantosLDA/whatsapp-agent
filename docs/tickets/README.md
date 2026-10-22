# Tickets

One markdown file per ticket. A ticket is written and agreed before it is implemented, and its file is updated as the work happens, so the folder doubles as a record of what was decided and why.

## How we use them

- **File name:** `WA-NNN-short-slug.md`.
- **Status** (in each file's header): `todo` → `in progress` → `in review` → `done`. `dropped` if we decide not to do it, with the reason.
- **One PR per ticket** where practical; the PR links the ticket and the ticket links the PR.
- **Changing scope** means editing the ticket first, in the same PR or before it.
- New tickets go at the end of the right milestone with the next free number.

## Template

```md
# WA-NNN: Title

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M1        | WA-001     |     |

## Why

## Scope

## Acceptance criteria

- [ ] ...

## Out of scope

## Notes
```

## Milestones and tickets

### M1: Foundation and simulator (demo can say "hello")

| Ticket                                  | Title                                     | Depends on     | Status    |
| --------------------------------------- | ----------------------------------------- | -------------- | --------- |
| [WA-001](WA-001-monorepo-setup.md)      | Monorepo, tooling and CI                  |                | in review |
| [WA-002](WA-002-client-config.md)       | Client config files and Jular config      | WA-001         | in review |
| [WA-003](WA-003-database.md)            | Database schema and migrations            | WA-001         | in review |
| [WA-004](WA-004-channel-and-webhook.md) | Channel interface and Meta-format webhook | WA-002, WA-003 | in review |
| [WA-005](WA-005-job-queue.md)           | Job queue abstraction                     | WA-004         | in review |
| [WA-006](WA-006-simulator-backend.md)   | Simulator channel backend                 | WA-004, WA-005 | in review |
| [WA-007](WA-007-simulator-ui.md)        | Simulator chat UI (Angular)               | WA-006         | in review |

### M2: Agent and catalogue (demo answers product questions)

| Ticket                                             | Title                              | Depends on     | Status    |
| -------------------------------------------------- | ---------------------------------- | -------------- | --------- |
| [WA-008](WA-008-shopify-catalogue-sync.md)         | Shopify catalogue sync             | WA-003         | in review |
| [WA-009](WA-009-agent-loop.md)                     | Agent loop with Claude             | WA-005, WA-002 | in review |
| [WA-010](WA-010-product-tools.md)                  | Product search and details tools   | WA-008, WA-009 | in review |
| [WA-011](WA-011-knowledge-languages-guardrails.md) | Policies, languages and guardrails | WA-009         | in review |
| [WA-012](WA-012-quantity-calculator.md)            | Quantity and price calculator      | WA-010         | in review |
| [WA-013](WA-013-checkout-links.md)                 | Checkout links                     | WA-010         | in review |

### M3: Business outputs (demo produces leads)

| Ticket                                      | Title                              | Depends on     | Status    |
| ------------------------------------------- | ---------------------------------- | -------------- | --------- |
| [WA-014](WA-014-lead-capture.md)            | Lead capture and LeadSink          | WA-009         | in review |
| [WA-015](WA-015-email-notifications.md)     | Email notifications and Mailer     | WA-014         | in review |
| [WA-016](WA-016-handoff-and-order-draft.md) | Handoff to human and order drafts  | WA-014, WA-015 | in review |
| [WA-017](WA-017-treehouse-qualifier.md)     | Modular house pre-sales            | WA-014         | in review |
| [WA-018](WA-018-backoffice-panel.md)        | Back-office panel in the simulator | WA-007, WA-014 | in review |

### M4: Quality and deploy (demo online)

| Ticket                       | Title                            | Depends on | Status |
| ---------------------------- | -------------------------------- | ---------- | ------ |
| [WA-019](WA-019-eval-set.md) | Eval set and model comparison    | M2, M3     | todo   |
| [WA-020](WA-020-deploy.md)   | Deploy to Cloud Run and Supabase | M1–M3      | todo   |

### Backlog (after the demo)

| Ticket                                     | Title                                    | Depends on     | Status |
| ------------------------------------------ | ---------------------------------------- | -------------- | ------ |
| [WA-030](WA-030-whatsapp-cloud-channel.md) | Real WhatsApp Cloud API channel          | WA-004         | todo   |
| [WA-031](WA-031-new-demo-client.md)        | Onboard a demo client from a website URL | WA-002, WA-008 | todo   |

Further ideas (no ticket yet): order status via Shopify Admin API, delivery scheduling, abandoned cart and back-in-stock alerts, technical sheets from jular.pt/downloads, Meta Tech Provider and Embedded Signup, admin dashboard, CRM sinks.
