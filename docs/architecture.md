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

| Concern                        | Choice                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Language                       | TypeScript, Node 24 LTS                                                           |
| Monorepo                       | pnpm workspaces                                                                   |
| API                            | Hono, Zod                                                                         |
| Database                       | Postgres (Supabase free tier in prod, Docker locally), Drizzle ORM                |
| Queue                          | In-process locally, Google Cloud Tasks in prod                                    |
| LLM                            | Claude API via `@anthropic-ai/sdk`; Claude Opus 5.5 default, model set per client |
| Simulator and future dashboard | Angular                                                                           |
| Leads                          | `LeadSink` interface: mock (simulator panel), Google Sheets                       |
| Email                          | `Mailer` interface: mock outbox, Resend                                           |
| Hosting                        | Google Cloud Run (free tier), one image: the API also serves the simulator        |
| Tests                          | Vitest                                                                            |

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

## Admin dashboard

The client's team works in an Angular app at `/admin` ([WA-022](tickets/WA-022-admin-app-and-login.md)), served by the same service as the simulator. Feature tickets (WA-023 to WA-029) plug into the structure below; follow it rather than adding new patterns.

**Sign-in.** Supabase Auth (email link or code, Google), invite only. The browser gets `SUPABASE_URL` and the anon key from `GET /admin/config` and signs in with `@supabase/supabase-js`; every API call sends the access token as `Authorization: Bearer`. The API verifies it with `jose` against the project's JWKS (cached) or the legacy HS256 secret ([admin/auth.ts](../apps/api/src/admin/auth.ts)). Members live in our `team_members` table (client, role `admin` or `sales`, branches), keyed by the Supabase user id; an invite is a row with the email and no user id, linked on the first sign-in. Locally, `ADMIN_DEV_LOGIN=true` adds "sign in as" buttons for seeded members (`pnpm db:seed`); the env check refuses it with `NODE_ENV=production` or on Cloud Run.

**API: one router, one folder per feature.**

- Routes live in `apps/api/src/admin/<feature>/routes.ts` and export `(deps: AdminDeps) => Hono<AdminEnv>`; services next to them in `service.ts`. Register a feature with one line in [admin/features.ts](../apps/api/src/admin/features.ts); it is mounted at `/api/admin/clients/:clientId/<feature>`.
- The router has already answered 401 (no or bad token) and 403 (not on this client's team) before a feature runs. Read the caller with `c.get('admin')`, an `AdminContext` ([admin/context.ts](../apps/api/src/admin/context.ts)): `user`, `member` (the team_members row), `client` (the merged config), `role`, `branches` and `branchIds`.
- Scope every query by `ctx.client.id`. For branch data use `branchFilter(ctx, table.branchId)` in the `where` (no limit for admins, `branch_id IN (...)` for sales), or `canSeeBranch` / `assertBranch` for one record. Admin-only routes add the `requireAdmin` middleware.
- Parse bodies with `parseBody(c, zodSchema)` (400 with the first problem) and fail with `throw adminError(status, code, message)`: the dashboard shows `message`, so write it in pt-PT. Request and response types go in `packages/shared/src/admin.ts` (or a feature file next to it) so the Angular app uses the same types.
- Services a feature needs (e.g. `TeamService` for owners and alerts) are built once in `createApp` and passed in `AdminDeps` ([admin/deps.ts](../apps/api/src/admin/deps.ts)).
- Server-sent events: `EventSource` cannot send headers, so the token may also come as `?access_token=` on a `GET` with `Accept: text/event-stream` (redacted from the request log). `AdminApi.streamUrl(path)` builds such URLs.
- Tests: `adminTestApp()` in [test/admin.ts](../apps/api/src/test/admin.ts) signs Supabase-like tokens with a local key; `t.member(clientId, { email, role, branches })` returns a token for a member, and `t.call(path, token, init)` calls the API.

**Settings.** Team-editable settings are stored in `client_settings` as overrides of `clients/<id>.yaml` (only what differs). `ClientRegistry.get()` returns the merged config, so every turn, lead and email sees a change at once; `onChange` listeners run (the agent drops its cached system prompt). Overrides live in memory after startup (`SettingsService.loadAll`), which is fine with one instance; scaling out needs a reload signal first. New settings: add the field to `clientSettingsSchema` and `applyClientSettings` in [packages/shared/src/settings.ts](../packages/shared/src/settings.ts).

**Personal data** ([WA-028](tickets/WA-028-privacy-tools.md)). Export, clear profile, delete and the retention job only touch data through `PersonalDataHandler`s ([privacy/registry.ts](../apps/api/src/privacy/registry.ts)): `{ name, tables, order?, export, erase, clearProfile? }`, where `erase` deletes rows or keeps them without personal content (returns `{ deleted }` or `{ anonymised }`) inside the one delete transaction. A feature that adds a table with a `contact_id` or `conversation_id` column, or a foreign key to contacts or conversations, adds its handler to `personalDataHandlers` in [privacy/handlers.ts](../apps/api/src/privacy/handlers.ts) (or registers it at runtime with `privacy.registerPersonalData`); `privacy.test.ts` fails until it does. Keep counts right by anonymising what statistics need (leads keep type, branch, status and dates). A customer is one contact today; WA-027 passes a `SubjectResolver` that returns all the contacts of a customer record, implements `clearProfile` for its profile store and honours `contacts.profiling_opt_out`.

**Angular app** (`apps/admin`, standalone, zoneless, signals, pt-PT copy, mobile first).

- Each screen is a lazy feature in `src/app/features/<feature>/` with a `<feature>.routes.ts` exporting `routes`; it is listed in `app.routes.ts` and in `shell/nav.ts` (`adminOnly` hides it from sales). Placeholders use `ComingSoon` until the feature replaces them.
- `AdminApi.client<T>(method, path, body?)` calls `/api/admin/clients/<current client><path>` with the token; a 401 signs out. `SessionStore` holds the member's context: `context()`, `isAdmin()`, `branches()`.
- Guards: `authGuard` on the shell (signed in and on a team), `adminGuard` for admin-only screens.
- Styles: global, in `src/styles.css`, on top of the shared tokens in `packages/shared/styles/tokens.css` (also used by the simulator). Reuse `.page`, `.card`, `.field`, `.btn`, `.input`, `.notice`; phones get a bottom tab bar, desktops (900 px and up) a side bar.
- Tests: Vitest through `ng test`. Fake `fetch` and provide `SUPABASE_AUTH_FACTORY` with `FakeSupabaseAuth` from `src/app/testing.ts`.
- Local development: `pnpm dev` serves the dashboard at `http://localhost:4300/admin/` (proxying `/api` and `/admin/config` to the API); `pnpm build` and the API serve it at `/admin`.
