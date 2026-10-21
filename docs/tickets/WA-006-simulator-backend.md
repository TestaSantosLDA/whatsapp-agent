# WA-006: Simulator channel backend

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M1 | WA-004, WA-005 | |

## Why
We want to build and demo without a Meta account, while exercising the same code path the real channel will use.

## Scope
- `SimulatorChannel` implementing `Channel`.
- Simulator API used by the Angular app:
  - `GET /sim/clients`: clients available to demo
  - `POST /sim/:clientId/messages`: the "customer" sends a message; the server wraps it in a Meta-format webhook payload and posts it through the normal `/webhook/simulator` path
  - `GET /sim/:clientId/stream?phone=...`: Server-Sent Events with outbound messages, typing indicator, and back-office events (leads, emails, handoffs, tool calls)
  - `POST /sim/:clientId/reset?phone=...`: clear a demo conversation
- Outbound messages use Meta's send-message JSON, stored and pushed over SSE.
- Simulator protected by a simple access code so a public demo URL is not open to everyone.

## Acceptance criteria
- [ ] With an echo handler, a message sent to `/sim/jular/messages` comes back over SSE within 1 second.
- [ ] The stored inbound payload is byte-compatible with the Meta fixtures from WA-004.
- [ ] Several simulated customers (phone numbers) can chat at the same time without mixing messages.
