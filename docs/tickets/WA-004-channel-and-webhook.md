# WA-004: Channel interface and Meta-format webhook

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M1        | WA-002, WA-003 |     |

## Why

The agent must not care whether a message came from the simulator or real WhatsApp. If both speak Meta's format, going live is a config change.

## Scope

- `Channel` interface in `apps/api`:
  - `parseInbound(payload) → InboundMessage[]` (text, interactive replies, images; ignore status callbacks for now)
  - `send(clientId, to, OutboundMessage)` for text, image with caption, reply buttons (max 3), list messages, and links
- Zod schemas for the subset of the WhatsApp Cloud API webhook and send-message JSON we use, in `packages/shared`.
- `POST /webhook/:channel` endpoint:
  1. verify the request (Meta signature for the real channel, a shared secret for the simulator)
  2. resolve the client from the receiving phone number id
  3. store the message, skip duplicates by message id
  4. enqueue a job and return `200` immediately
- `GET /webhook/whatsapp` verification handshake (needed later by Meta, cheap to add now).

## Acceptance criteria

- [ ] Unit tests with recorded Meta payload fixtures (text, button reply, image).
- [ ] Duplicate deliveries of the same message id produce one stored message and one job.
- [ ] Webhook answers in under 200 ms locally regardless of agent work.

## Out of scope

The real WhatsApp send implementation (WA-030).
