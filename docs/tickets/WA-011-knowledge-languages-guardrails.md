# WA-011: Policies, languages and guardrails

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M2        | WA-009     |     |

## Why

Use case 3 (FAQ) and the rules that keep the agent safe to put in front of customers.

## Scope

- Policies from client config placed in the cached system prompt: shipping, unloading rules, pickup, payment methods, cancellation, returns, store vs online prices, newsletter discount, contacts and hours per branch.
- Language: reply in the customer's language; European Portuguese by default (no Brazilian forms, formal "você"), English otherwise. Store detected language on the contact.
- First message from a new contact: say it is an automated assistant, link the privacy policy, offer a human.
- Guardrails in the prompt and in code:
  - prices, stock and product facts only from tool results
  - no promised delivery dates or discounts beyond policy
  - out-of-scope or abusive messages handled politely
  - "falar com uma pessoa" / "talk to a human" always triggers handoff (WA-016)
- Opening-hours awareness: the agent knows the current time in Europe/Lisbon and whether branches are open.

## Acceptance criteria

- [ ] Eval cases for 10 FAQ questions answered correctly from the policy text.
- [ ] Asking for a discount or a delivery date never yields an invented one.
- [ ] A sample of 20 Portuguese replies reviewed by a native speaker reads as European Portuguese (e.g. "estou a ver", not "estou vendo").
