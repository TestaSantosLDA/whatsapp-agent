# WA-027: Customer records and profiles

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| todo   | M5        | WA-022, WA-028 |     |

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

- [ ] After two eval conversations with the same contractor, the second reply is shorter and reuses their usual products, and the profile shows why (eval case, WA-019).
- [ ] The profile only ever contains the allowed fields (tests on the tool), and an edited or locked field is never overwritten by the agent.

## Out of scope

Scoring or ranking customers, sharing profiles across clients (never: each client's data stays its own), automated decisions with legal effect (prices are always set by people).

## Notes

GDPR: this is profiling, so Jular's privacy notice must mention it and customers can object (WA-028, "clear profile"). The service is the processor and Jular the controller; profile data is never used for any other client.
