# WA-018: Back-office panel in the simulator

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M3 | WA-007, WA-014 | |

## Why
In a sales demo, the prospect needs to see what their team gets, not only what the customer sees.

## Scope
Right-hand panel in the simulator, fed by the SSE stream:
- **Leads:** each lead as a card with its fields and routed branch.
- **Emails:** each outbox email, openable.
- **Handoffs:** status of the conversation (bot / human) with a "return to bot" button.
- **Agent trace:** tools called with inputs and results, tokens and estimated cost per turn. Collapsible; off by default for client-facing demos.

## Acceptance criteria
- [ ] During a demo conversation, a lead appears in the panel within 2 seconds of being saved.
- [ ] The trace can be hidden with one toggle and the setting is remembered.
