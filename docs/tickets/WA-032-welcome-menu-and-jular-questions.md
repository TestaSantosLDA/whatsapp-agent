# WA-032: Welcome menu and Jular's real customer questions

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | Backlog   | WA-009, WA-019 |     |

## Why

Jular sent (2026-10-23) the three questions customers most often start with, and a list of real customer questions. A customer who only says "Olá" should see those three options as buttons, and the agent should answer the real questions correctly, or say clearly what is still to be confirmed.

## Scope

- **Welcome menu (generic):** optional `welcome_menu` in the client config, 2 or 3 items, each a `title` (max 20 characters, a WhatsApp button) and an `about` (what the customer wants and what the agent does next). On the first message of a new contact, when it is only a greeting, the agent shows the menu with `offer_choices` (translated for a customer writing in another language). When the first message already asks something, it answers and shows no menu.
- **Jular:** `welcome_menu` with "Procuro um produto", "Comprar ou orçamento" and "Lojas e contactos".
- **Evals:** `evals/jular/jular-questions.yaml`: the menu (greeting in pt-PT and English, a direct question without menu) and the customer questions: modular-house typologies, where to see prices, deck installation, pavilions, house foundations. The last three are "to confirm" cases: the agent must not invent the answer until Jular replies. The eval set limit goes from 48 to 60 cases.

## Waiting on Jular

- Do you install decks, or only supply the material?
- Do you build or assemble pavilions, or only supply the wood (Kerto, up to 40 m spans)?
- What foundation does a Treehouse need (slab, piles, other), and who does it?
- What does the Treehouse price include?

When the answers arrive: add them to `clients/jular.yaml` (business lines or the Treehouse skill) or upload them as a document (WA-026), and tighten the three "to confirm" rubrics.

## Acceptance criteria

- [x] With `welcome_menu` set, the first-contact turn context asks for the menu and later turns do not; without it nothing changes (`claude-responder.test.ts`).
- [x] A title over 20 characters is refused by the config schema.
- [x] The new eval cases are valid and only name real tools and branches (`evals.test.ts`).
- [ ] An eval run on the real model passes the new cases (needs `ANTHROPIC_API_KEY` locally).
