# WA-032: Welcome menu and Jular's real customer questions

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| done   | Backlog   | WA-009, WA-019 | #12 |

## Why

Jular sent (2026-10-23) the three questions customers most often start with, and a list of real customer questions. A customer who only says "Olá" should see those three options as buttons, and the agent should answer the real questions correctly, or say clearly what is still to be confirmed.

## Scope

- **Welcome menu (generic):** optional `welcome_menu` in the client config, 2 or 3 items, each a `title` (max 20 characters, a WhatsApp button) and an `about` (what the customer wants and what the agent does next). On the first message of each new conversation (a new contact, or a known customer whose last conversation was closed), when it is only a greeting, the agent shows the menu with `offer_choices` (translated for a customer writing in another language). When the first message already asks something, it answers and shows no menu.
- **Jular:** `welcome_menu` with "Procuro um produto", "Comprar ou orçamento" and "Lojas e contactos".
- **Evals:** `evals/jular/jular-questions.yaml`: the menu (greeting in pt-PT and English, a direct question without menu) and the customer questions: modular-house typologies, where to see prices, deck installation, pavilions, house foundations. The last three are "to confirm" cases: the agent must not invent the answer until Jular replies. The eval set limit goes from 48 to 60 cases.

## Jular's answers (2026-10-23)

- Decks: Jular only supplies the material, it does not install.
- Pavilions: both, it builds complete Kerto pavilions or supplies only the wood.
- Treehouse foundations: Jular does the whole job, foundations included.
- What the Treehouse price includes: still to confirm.

The answers are in `clients/jular.yaml` and the deck, pavilion and foundation evals check them. The remaining open questions for Jular are in `docs/jular-perguntas-em-aberto.md`.

## Acceptance criteria

- [x] With `welcome_menu` set, the first-contact turn context asks for the menu and later turns do not; without it nothing changes (`claude-responder.test.ts`).
- [x] A title over 20 characters is refused by the config schema.
- [x] The new eval cases are valid and only name real tools and branches (`evals.test.ts`).
- [ ] An eval run on the real model passes the new cases (needs `ANTHROPIC_API_KEY` locally).
