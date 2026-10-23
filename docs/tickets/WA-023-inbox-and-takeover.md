# WA-023: Inbox and takeover

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| todo   | M5        | WA-022, WA-016 |     |

## Why

When the agent hands over, a person has to reply quickly from wherever they are, see the whole conversation and give it back to the bot when done.

## Scope

- **Inbox:** conversations newest first, filters (needs a person, mine, branch, all), unread badge, live updates (SSE, like WA-018).
- **Conversation view:** full transcript including product cards, taps and files; the customer's record and profile beside it (WA-027); leads and quotes from this conversation.
- **Take over:** sets the conversation to `human` (the agent stays silent); **reply as a person** sends a WhatsApp message through the channel (the simulator in the demo), marked as sent by that member; **return to bot** hands it back. Assignment to a member.
- **Alerts:** a handoff or a customer message on a `human` conversation notifies the assigned member (else the branch) by email straight away; web push on the installed dashboard (PWA) where the phone allows it.

## Acceptance criteria

- [ ] During a demo, "falar com uma pessoa" in the simulator shows up in the inbox within 2 seconds, a salesperson takes over and replies from a phone, and the reply appears in the simulator chat.
- [ ] After "return to bot", the agent answers the next customer message with the person's replies in its history.

## Out of scope

Canned replies, internal chat between colleagues, the 24-hour WhatsApp window rules (WA-030).
