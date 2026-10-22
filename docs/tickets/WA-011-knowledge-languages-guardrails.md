# WA-011: Policies, languages and guardrails

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M2        | WA-009     |     |

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

## Implementation notes

- System prompt in `apps/api/src/agent/prompt.ts`: voice, pt-PT rules (with examples of Brazilian forms to avoid), WhatsApp style, honesty rules, handoff triggers, branches with hours, routing, lead response time and every policy from the config.
- Formal register: the prompt asks for the third person ("Pode enviar-me…") with "você" used sparingly and never "tu", which reads more natural in Portugal than "você" everywhere. Jular's `brand_voice` still says "você"; worth a native check (third criterion).
- Language: a word-list guess (`agent/language.ts`) is stored on the contact and picks the language of fixed texts (apology, list button); Claude replies in whatever language the customer writes.
- First contact: the turn context tells Claude to say it is an automated assistant, link `privacy_policy_url` (new optional config field) and offer a colleague.
- "falar com uma pessoa" / "talk to a human" is also matched in code: if Claude did not call `request_human`, the responder does. `request_human` stores a `handoff` lead and sets the conversation to `human`; WA-016 adds the email.
- Opening hours: the turn context carries the current Lisbon time and which branches are open now (`agent/hours.ts`, DST-aware).
- The FAQ eval cases and the native-speaker review are open until WA-019 and an API key.
