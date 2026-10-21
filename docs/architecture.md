# Architecture

Summary of the architecture agreed on 2026-10-21. The full write-up with diagram lives in the [architecture doc](https://claude.ai/artifact/Ezzhhw2twyVa1JTqxCZvkW); the [brainstorm doc](https://claude.ai/artifact/HsUWTFctefWUFSGeVMwz63) has the research on Jular and the use cases.

## Goal

A WhatsApp agent we can sell to many companies. Jular Madeiras is client #1. The MVP runs against a **WhatsApp simulator** so it can be built and demoed without a Meta account; real WhatsApp is plugged in per client later.

## MVP use cases

1. Product advisor (recommends from the live catalogue)
2. Quantity and price calculator (m² to boxes, skirting, underlay)
3. FAQ and policies (shipping, pickup, payment, cancellation, hours)
4. Lead capture and quote requests (info / quote / sample)
5. Handoff to a human, routed by branch and business line
6. Modular house (Treehouse) pre-sales qualification

## Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript, Node 22 |
| Monorepo | pnpm workspaces |
| API | Hono, Zod |
| Database | Postgres (Supabase free tier in prod, Docker locally), Drizzle ORM |
| Queue | In-process locally, Google Cloud Tasks in prod |
| LLM | Claude API via `@anthropic-ai/sdk`; Claude Opus 5.5 default, model set per client |
| Simulator and future dashboard | Angular |
| Leads | `LeadSink` interface: mock (simulator panel), Google Sheets |
| Email | `Mailer` interface: mock outbox, Resend |
| Hosting | Google Cloud Run (free tier), one Docker image per app |
| Tests | Vitest |

Only the Claude API costs money. Everything else stays on free tiers at MVP volume.

## Components

```
Customer ──> Channel (Simulator | WhatsApp Cloud API)
                │  Meta-format webhook payloads
                v
          Webhook ──> Queue ──> Worker / agent loop ──> Claude API
                                     │
                                     ├─ tools: products, calculator, checkout link,
                                     │         save lead, order draft, handoff
                                     ├─ Postgres: clients, conversations, messages, products
                                     └─ LeadSink / Mailer
Shopify feed ──(hourly sync)──> Postgres
```

## Key rules

- **Multi-client from day one.** Every row has a `client_id`; each client is a YAML config file (brand, languages, tone, branches, hours, routing, lead fields, enabled tools, model, policy text).
- **Channel adapter.** The agent only knows the `Channel` interface. The simulator speaks Meta's exact webhook and send-message JSON, so moving a client to real WhatsApp is a config change.
- **Grounded answers.** Prices and stock come only from tool results. No delivery-date promises. A human is always one message away.
- **Languages.** European Portuguese by default, English when the customer writes in English.
- **Checkout links** use Shopify cart permalinks (`/cart/<variant_id>:<qty>`). Special-transport products, islands and abroad fall back to an emailed order draft.
