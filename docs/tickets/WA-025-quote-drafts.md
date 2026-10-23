# WA-025: Quote drafts from the conversation

| Status | Milestone | Depends on             | PR  |
| ------ | --------- | ---------------------- | --- |
| todo   | M5        | WA-024, WA-012, WA-026 |     |

## Why

The agent has already collected the products, the area and the quantities. Turning that into a quote should take a salesperson two minutes, not twenty.

## Scope

- From a lead, **Create quote** prefills lines from what the agent gathered (products and variants from the catalogue, quantities from the calculator, delivery or pickup, customer details).
- The salesperson edits lines, prices and discounts (per line or total), validity date and notes; totals with IVA are computed by code.
- **PDF** with the client's letterhead, logo, legal details and conditions (from config), numbered per client and year (e.g. `JUL-2026-0042`).
- **Send** by email to the customer from the dashboard, or as a document in the WhatsApp conversation; the lead moves to `quoted`.
- The agent can tell a customer the status of their quote ("foi-lhe enviado ontem pela equipa da Maia").

## Acceptance criteria

- [ ] From a demo deck lead, a quote PDF with correct quantities and totals is produced and delivered to the simulator chat in under two minutes of clicks.
- [ ] Line totals, discounts and IVA are computed by tested code, never by the model.

## Out of scope

Invoices, payments, stock reservation, ERP integration (PHC / Primavera), e-signature.

## Notes

Needs from Jular: letterhead, legal footer, quote conditions, numbering preference, who may give which discounts.
