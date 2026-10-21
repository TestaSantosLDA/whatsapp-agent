# WA-030: Real WhatsApp Cloud API channel

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | Backlog | WA-004 | |

## Why
Go live for a client: switch their config from `simulator` to `whatsapp_cloud`.

## Scope
- `WhatsAppCloudChannel.send` via the Graph API `/<phone_number_id>/messages` with the client's access token.
- Webhook signature check (`X-Hub-Signature-256` with the app secret).
- Media download for images and documents customers send.
- Message status callbacks (sent, delivered, read, failed) stored on `messages`.
- 24-hour customer-service window: outside it, only approved templates may be sent; the agent never tries a free-form message there.
- Setup guide in `docs/`: Meta Business account, app, phone number, webhook URL, tokens.

## Acceptance criteria
- [ ] A conversation on Meta's test number works end to end with no code changes outside this channel.
- [ ] Jular can be switched between simulator and real WhatsApp by config.

## Notes
Multiple clients: one Meta app serves all clients; routing is by `phone_number_id`. Self-service onboarding (Tech Provider + Embedded Signup) is a later ticket.
