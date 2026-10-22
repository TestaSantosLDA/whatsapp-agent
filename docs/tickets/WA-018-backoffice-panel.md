# WA-018: Back-office panel in the simulator

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M3        | WA-007, WA-014 |     |

## Why

In a sales demo, the prospect needs to see what their team gets, not only what the customer sees.

## Scope

Right-hand panel in the simulator, fed by the SSE stream:

- **Leads:** each lead as a card with its fields and routed branch.
- **Emails:** each outbox email, openable.
- **Handoffs:** status of the conversation (bot / human) with a "return to bot" button.
- **Agent trace:** tools called with inputs and results, tokens and estimated cost per turn. Collapsible; off by default for client-facing demos.

## Acceptance criteria

- [x] During a demo conversation, a lead appears in the panel within 2 seconds of being saved.
- [x] The trace can be hidden with one toggle and the setting is remembered.

## Notes

- **API:** `GET /sim/:clientId/backoffice?phone=` is a Server-Sent Events stream, simulator clients only, behind the same access code as the rest of `/sim` (also as `?code=`, since EventSource cannot send headers). It sends a `snapshot` of the customer's open conversation first, then the `lead`, `email`, `turn` and `conversation` events that `BackofficeService` publishes on its bus, with a 15 s heartbeat. It subscribes before reading the snapshot, so nothing saved in between is lost; the UI dedupes by id what lands in both. The contract is `BackofficeEvent` in `packages/shared/src/backoffice.ts`, unchanged.
- **Within 2 seconds:** whoever saves a lead, email or agent run publishes it straight away, so the panel gets it as one SSE push, well under a second locally. Tests in `apps/api/src/routes/backoffice.test.ts` cover the snapshot, every live event type, customers kept apart, 404 for non-simulator clients and the access code.
- **UI:** `BackofficeStore` (signals, one EventSource, retry after 3 s when the server closes the stream) follows the chat: it starts over on a client or persona switch and after a conversation reset (`ChatStore.session`). `BackofficePanel` shows Conversa (bot / humano badge and "Devolver ao bot"), Leads (type, routed branch, fields), Emails (click opens recipients, subject and body) and Trace do agente (per turn: tools with input and result, tokens, cache reads, cost in USD as stored, latency; each turn and tool collapsible). Copy is pt-PT.
- **Trace toggle:** off by default, so a client-facing demo shows only the business side; the choice is kept in `localStorage` (`wa-sim.showTrace`), and the app still works when storage is blocked.
- **Return to bot:** the button calls `POST /sim/:clientId/conversation/bot?phone=` (WA-016). It updates the badge on success; on a 404 it says the server does not support it yet.
- **Layout:** on desktop the panel sits right of the phone with its own scroll. Below 960 px it is a second tab: the "Back-office" button in the top bar (with the lead count) swaps it with the chat, so there is no horizontal scroll.
- **Screenshots:** `m3/backoffice-desktop.png`, `m3/backoffice-trace.png` and `m3/backoffice-mobile.png` in the project files.
