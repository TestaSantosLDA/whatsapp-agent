# WA-029: Overview and "couldn't answer" list

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M5        | WA-022, WA-024 |     |

## Why

Management wants to know what the agent brings in, and the team needs to know what to teach it next.

## Scope

- **Overview:** this week and month per branch: conversations, leads by type, handoffs, quotes sent, won/lost, median first response by the team, Claude cost.
- **Couldn't answer:** questions where the agent said it would check with a colleague, handed over for lack of information, or a tool found nothing; grouped by topic with examples and counts, each with "upload a document" (WA-026) or "dismiss".
- **Most asked products** and searches with no result (products customers want that are not in the store).
- **Weekly email** to admins every Monday with these numbers and the top five gaps.

## Acceptance criteria

- [ ] After the eval set runs against a demo client, the overview numbers match the database (tests) and the "couldn't answer" list shows the cases where the agent deferred. Verified locally with conversations played through the real agent (simulator → queue → `ClaudeResponder` → tools) with a scripted fake Claude, not the eval set against live Claude (no API key here): `admin/overview/overview.test.ts` compares every figure with direct queries and checks the deferral, the handoff for lack of information and the empty searches are listed while the found product, the quote and the request for a person are not. Still to check after a real eval run.

## Out of scope

Custom reports, BI exports beyond CSV.

## Implementation (2026-10-23)

Everything is computed from data that already exists; no new event logging in the agent.

**Overview** (`GET /api/admin/clients/:clientId/overview?branch=`, [admin/overview](../../apps/api/src/admin/overview/)): this week (Monday 00:00 in the client's time zone) and this month (the 1st), both up to now, and a per-branch table (leads, handoffs, won, lost). Figures: conversations with a customer message in the period; leads saved by type (handoffs excluded); handoffs and their reason (`handoff_to_human`'s reason in the lead fields); leads that moved to `quoted` (`quoted_at`); won and lost by `closed_at`, lost by reason (WA-024's fixed list); the team's first response = median from saved to `contacted_at`, in calendar minutes and in the branch's opening hours (`workingHoursBetween`, like the reminders), plus how many are still `new`; Claude's cost = `agent_runs.cost_usd` plus document reading (`documents.cost_usd`, WA-026) and the number of turns. Everyone can open it: sales see their branches only, and conversations for a branch are those with a lead of that branch (conversations have no branch). Cost is shown to admins looking at all branches only (it is not attributable to a branch). Shared types in `packages/shared/src/insights.ts`.

**Couldn't answer** (`GET /overview/gaps?days=30`, admins): three signals, each matched to the customer's message just before it (one entry per question, reasons merged): (1) an outbound message where the agent says it will confirm/check/ask with a colleague or the team (pt, en, es, fr; regex `isDeferral` in `gaps.ts`, "a colleague will reply here" is not a deferral); (2) a handoff lead with reason `could_not_help`; (3) an agent turn where `search_products` returned `count: 0` or `search_documents` returned no passages and no other search with the same tool in that turn found something. Topics are assigned without Claude: the most specific catalogue `product_type` the question (plus the empty search's words) names, allowing plurals; else a fixed theme (Entregas e transporte, Instalação e manutenção, Especificações técnicas, Stock e prazos, Preços e descontos, Garantia e devoluções, Encomendas e faturas, Lojas e horários); else "Outros". Each topic shows counts per reason and up to three examples (question, the agent's deferral, date), with "Carregar documento" (to Conhecimento, WA-026) and "Ignorar". `POST /overview/gaps/dismiss { topic }` stores the topic in `insight_gap_dismissals` with the time: questions up to then are hidden, newer ones show again.

**Most asked products and searches with no result** (`GET /overview/products?days=30`, everyone): products the agent looked up (`get_product`) or showed (`show_products`), counted by distinct conversations, top 10; `search_products` calls with no result grouped by normalised words, top 10. Customers deleted under WA-028 drop out (their `agent_runs` lose tool inputs).

**Weekly email**: `POST /jobs/weekly-insights` (JOBS_SECRET, `?client=`) sends each client's admins last week's figures (Monday to Sunday, all branches, with cost) and the top five topics with one example each (shortened to 120 characters), linking to `/admin/overview`. The week is claimed in `insight_reports` (unique client + week) before sending, so reruns answer `already_sent`. Cloud Scheduler job `wa-weekly-insights`, Mondays 08:00 Lisbon, in [deploy.md](../deploy.md) step 13 (the fourth job: about $0.10/month beyond the free three). Email kind `weekly_insights`.

**Schema** (`db/schema.ts`, "WA-029"): `insight_gap_dismissals` (client, topic, dismissed_by, dismissed_at; unique client + topic) and `insight_reports` (client, week_start, recipients). Neither holds customer data (topics are product types or fixed themes), so no privacy handler is needed.

**Dashboard** (`apps/admin/src/app/features/overview`): period toggle (Esta semana / Este mês), branch picker when the member sees more than one branch, stat tiles, single-hue bar lists (by type, handoff reason, lost reason), per-branch table, then for admins the "couldn't answer" cards, and for everyone most asked products and searches with no result. Component styles only (no change to `styles.css`). Uses `shortBranch` from the leads feature for branch names.

**Tests.** API `admin/overview/overview.test.ts`: week/month starts across DST and month boundaries, median, deferral regex, empty-search rule, topic assignment; end to end: five conversations through the real agent with a scripted Claude, then the overview compared with direct SQL (conversations, leads, handoffs, won after a status change, first response 90 min, cost and turns), next week's figures, the gaps list and dismissal (admins only), products and missing searches, branch scoping for sales (no cost, 403 for another branch, 400 unknown branch), the Monday email (contents, sent once) and the jobs route. Dashboard `overview.page.spec.ts`: tiles, month toggle, branch filter, gaps and dismiss, sales view.

**Screenshots** (`/mnt/project-files/m5/`, dev login, jular with a scripted fake Claude): `wa029-overview-mobile.png`, `wa029-overview-mobile-full.png`, `wa029-overview-mobile-month.png`, `wa029-overview-mobile-sales.png`, `wa029-overview-desktop.png`.

### Open items

- TODO(WA-025): `quotesSent` is `null` until quote drafts exist; then count quotes sent in the period (the tile already shows it when not null). Today "Orçamentados" counts leads moved to `quoted`.
- TODO(WA-023): the first response only uses the lead's `contacted_at`; add the first reply a member sends from the inbox (handoffs especially). Once inbox replies are stored as outbound messages marked as sent by a member, leave them out of the deferral scan (`gapEvents` in `service.ts`), or a person writing "vou confirmar com um colega" would count as the agent deferring. Example links to `/inbox/<conversationId>` can be added then (`conversationId` is already in the API).
- Topics are keyword-based; a Claude clustering pass (e.g. in the weekly job) could name finer topics later.
- Run the real eval set (`pnpm eval --client jular`) with an API key and check the overview against that run.
- Cost is in USD (as stored); no currency conversion.
