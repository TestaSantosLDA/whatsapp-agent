# WA-017: Modular house pre-sales

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M3        | WA-014     |     |

## Why

Use case 6. Treehouse leads are worth €44k–€150k+ each; a fast, well-qualified first answer matters more here than anywhere else.

## Scope

- Treehouse knowledge in Jular's config: models and listed prices (Spot T1A, SW T2A, Douro T2), 22 m² modules, the 6-step process, showroom in Azambuja.
- A client-specific "skill" (prompt section + lead fields) enabled only for Jular: use (home, tourism, office), land owned and location, licensing status, budget range, timeline.
- Ends with a `save_lead` of type `quote` for the modular business line and an offer to book a showroom visit (visit request captured as a lead field; no calendar integration yet).

## Acceptance criteria

- [x] "Quanto custa uma casa T2?" gets the listed prices, what is not included is stated as "to confirm with the team", and the qualifying questions follow.
- [x] The lead reaches the modular-house recipient from config.

## Notes

Needs from Jular: what each price includes, lead times, who handles modular leads.

Implementation (M3):

- Generic `skills:` in the client config (`skillSchema` in packages/shared): `when`, `instructions`, `business_line`, `lead_type`, `lead_fields` (id, question, required). Each skill becomes a section of the frozen system prompt, so it stays cached.
- `save_lead` takes the answers in `details` and refuses (`missing_fields`) while a required skill field is missing. For Treehouse, `use` and `land` are required.
- The Treehouse lead routes to Azambuja through the existing business-line rule and is emailed to Azambuja's `lead_emails` (a placeholder until Jular says who handles modular leads).
- The first criterion is covered by the prompt text and its test. It was not checked against the live model, because there is no API key yet.

Still needed from Jular: what each price includes, lead times, who receives modular leads.

Follow-up (#6 and M4 review fixes):

- Skill field ids may not reuse a core lead key (name, location, timeline, phone, summary and the rest); the config loader rejects that. Core keys sent in `details` never replace the core values. When the core parameter is empty, they are used as its value.
- Without `business_line`, the skill is inferred only from an answer to one of its required questions (for Treehouse, `use` or `land`). Its business line then routes the lead.
