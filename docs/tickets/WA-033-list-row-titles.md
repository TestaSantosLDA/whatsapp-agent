# WA-033: Product list rows a customer can tell apart

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | Backlog   | WA-009     |     |

## Why

A list of 4 to 10 products shows each name cut to WhatsApp's 24-character row title. Many catalogue names share a long start ("Pavimento Flutuante de Madeira Multicamadas - …"), so every row read "Pavimento Flutuante de…" and the customer could not tell them apart (reported on the live demo, 2026-10-23).

## Scope

- `show_products` takes optional `row_titles`: a short title per product, written by Claude, that says what sets it apart.
- Without them, the row title is the product name without the words all listed names share ("Kährs Carvalho Amber").
- The row description keeps the variant, the price and the stock, and adds the full name when the title does not show it.

## Acceptance criteria

- [x] The eight Jular floating floors from the report get eight different titles (`tools.test.ts`).
- [x] Row titles and descriptions stay within WhatsApp's limits; a given title over 24 characters is refused.
