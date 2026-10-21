# WA-017: Modular house pre-sales

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M3        | WA-014     |     |

## Why

Use case 6. Treehouse leads are worth €44k–€150k+ each; a fast, well-qualified first answer matters more here than anywhere else.

## Scope

- Treehouse knowledge in Jular's config: models and listed prices (Spot T1A, SW T2A, Douro T2), 22 m² modules, the 6-step process, showroom in Azambuja.
- A client-specific "skill" (prompt section + lead fields) enabled only for Jular: use (home, tourism, office), land owned and location, licensing status, budget range, timeline.
- Ends with a `save_lead` of type `quote` for the modular business line and an offer to book a showroom visit (visit request captured as a lead field; no calendar integration yet).

## Acceptance criteria

- [ ] "Quanto custa uma casa T2?" gets the listed prices, what is not included is stated as "to confirm with the team", and the qualifying questions follow.
- [ ] The lead reaches the modular-house recipient from config.

## Notes

Needs from Jular: what each price includes, lead times, who handles modular leads.
