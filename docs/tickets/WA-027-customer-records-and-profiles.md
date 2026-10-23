# WA-027: Customer records and profiles

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M5        | WA-022, WA-028 |     |

## Why

Professionals (carpenters, builders, architects) come back again and again. The team should see their history at a glance, and the agent should serve each one the way they like: a quick price for the experienced contractor, technical detail for the one who wants it, like a personal sales assistant.

## Scope

- **Customer record:** name, company, NIF, role (private, carpenter, builder, architect, reseller, other), regions, linked WhatsApp number(s); all their conversations, leads, quotes and order drafts; free notes by the team.
- **Profile** (service preferences, kept factual):
  - detail level (short answers / full explanations), technical depth, preferred language;
  - usual products and typical quantities;
  - commercial facts such as "negotiates on volume", "asks for delivery on site", price tier.
    The agent proposes updates after a conversation (a `note_profile` tool limited to these fields); the team sees, edits and can lock any field. No free-text judgements about the person: the tool only accepts the listed fields and short factual values.
- **Use by the agent:** the record summary and profile go into the per-turn context (not the cached prompt), so replies adapt; "o mesmo da última vez" finds the last order or quote.
- Profiling can be switched off per client and is cleared per customer from WA-028.

## Acceptance criteria

- [ ] After two eval conversations with the same contractor, the second reply is shorter and reuses their usual products, and the profile shows why (eval case, WA-019). The cases (`evals/jular/profile.yaml`) and the runner support (earlier conversations, `profile` and `shorter_than_earlier` checks) are in and tested with a scripted Claude; still to run against the real model (needs `ANTHROPIC_API_KEY`).
- [x] The profile only ever contains the allowed fields (tests on the tool), and an edited or locked field is never overwritten by the agent.

## Out of scope

Scoring or ranking customers, sharing profiles across clients (never: each client's data stays its own), automated decisions with legal effect (prices are always set by people).

## Notes

GDPR: this is profiling, so Jular's privacy notice must mention it and customers can object (WA-028, "clear profile"). The service is the processor and Jular the controller; profile data is never used for any other client.

## Implementation (2026-10-23)

Decisions from the product owner: profiling stays in with guardrails: only factual service preferences, never sensitive or inferred personal traits; the team views and edits the profile; "clear profile" goes through WA-028; no profile is built or used when `contacts.profiling_opt_out` is set; one client's data is never used for another.

- **Records** (`customers`, `customer_notes`, `contacts.customer_id`): every WhatsApp contact belongs to one record, created the first time it is needed (agent turn, dashboard list or `GET …/customers/by-contact/:contactId`). The team edits name, company, NIF, role (private, carpenter, builder, architect, reseller, other) and regions, adds notes, links another number (a number that has not written yet becomes a contact; a number of another record moves and that empty record is merged in) and separates a number. Record page: numbers, conversations (message count, last message), leads and order drafts, notes, profile.
- **Profile** (`customer_profile_fields`, one row per field): `detail_level` (short/full), `technical_depth` (basic/technical), `language`, `usual_products` (name, variant id, typical quantity; merged, max 8), `job_types`, `delivery` (site/pickup), `negotiates_on_volume`, `price_tier` (team only: prices are set by people). Values are checked by the same zod schemas (`packages/shared/src/customers.ts`) whoever writes them, with a guardrail on free text (health, beliefs, origin, sexuality, family, finances, age and judgements about the person are refused). Each value keeps its source (agent/team), lock, and the "why": the customer's own words and the conversation.
- **`note_profile`** (core tool, only for clients with `profiling.enabled`): strict input (only the agent's fields), `evidence` must be words the customer wrote in this conversation, refused when the customer opted out. A field the team set or locked (also locked empty) is never written by the agent (checked again in the upsert's `WHERE`).
- **Use by the agent:** the turn's system message (not the cached prompt) gets the team's record facts (no NIF), the profile with why (only when profiling is on), which fields the team keeps, and the last three order drafts and quote requests of all the record's numbers, for "o mesmo da última vez". The system prompt gains "Returning customers" and, with profiling on, "Customer profile" (how to adapt; never mention the profile).
- **Profiling off:** `profiling.enabled` in the client config (default **off**, on in `clients/jular.yaml`: the privacy notice must mention it first); per customer through "clear profile" (any team member, audited) or WA-028's request flow. Then the tool refuses, the context says so, team edits get 409 and nothing is shown.
- **Privacy (WA-028):** handlers `customer_profile` (with `clearProfile`) and `customer_records` in `privacy/handlers.ts`; `customerSubject` passed to `PrivacyService`, so export, clear profile and delete cover every number of a record.
- **Who sees what:** admins every record; sales the records with a lead or handoff on one of their branches, and only those leads.
- **Evals (WA-019):** use case `profile`, case field `earlier` (conversations played first, then closed), checks `profile` and `shorter_than_earlier`; the profile at the end goes into the transcript, the grader input and the report. Two cases in `evals/jular/profile.yaml` (pt-PT, en).
- **Dashboard:** `features/customers`: list (search, role chips) and record page (preferences with why, edit, lock, delete a field, clear profile with confirmation; leads; conversations; record form; numbers; notes). Screenshots: `/mnt/project-files/m5/wa027-*.png`.
- **Tests:** `apps/api/src/admin/customers/customers.test.ts` (allowed fields and guardrail, tool refusals, team/locked fields kept, turn context and cached prompt, clear profile and WhatsApp request, client with profiling off, sales scoping, client separation with the same number, link/merge/unlink and privacy export/delete over two numbers), `apps/api/src/evals/profile.test.ts`, `customers.page.spec.ts`.

### Open items

- Run the two profile eval cases on the real model.
- Quotes (WA-025) should appear on the record page and in the "last orders" context once they exist.
- WA-023 can show the record beside a conversation with `GET …/customers/by-contact/:contactId`.
- Re-enabling profiling after an objection is not offered (only the customer's new consent should do it; needs a decision).
- The free-text guardrail is a word list (pt/en), a safety net under the closed field list, not a classifier.
