# WA-016: Handoff to human and order drafts

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M3 | WA-014, WA-015 | |

## Why
Use case 5, and the fallback for orders that cannot go through a checkout link.

## Scope
- `handoff_to_human` tool: reason, urgency, summary. Sets the conversation to `human`, notifies the routed branch (email), and tells the customer when to expect a reply based on that branch's opening hours.
- Triggers: the customer asks for a person; repeated misunderstanding; complaints; large or complex projects (rules in config).
- While in `human` status the bot stays silent. A command from the back-office panel (and later the real dashboard) returns the conversation to `bot`.
- `send_order_draft` tool: cart items, quantities, delivery address or pickup, customer details. Emails the draft to the sales team, stores it as a lead of type `order`, and tells the customer the team will confirm price and transport.

## Acceptance criteria
- [ ] "Quero falar com alguém" at 22:00 → handoff, customer told the team replies after 9:00, email in outbox.
- [ ] After handoff, new customer messages get no bot reply.
- [ ] A cart with a special-transport product produces an order draft, not a checkout link.

## Notes
In real WhatsApp mode, staff reply from the WhatsApp Business app via coexistence or from a future inbox. Out of scope for the demo.
