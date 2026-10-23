# WA-023: Inbox and takeover

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M5        | WA-022, WA-016 |     |

## Why

When the agent hands over, a person has to reply quickly from wherever they are, see the whole conversation and give it back to the bot when done.

## Scope

- **Inbox:** conversations newest first, filters (needs a person, mine, branch, all), unread badge, live updates (SSE, like WA-018).
- **Conversation view:** full transcript including product cards, taps and files; the customer's record and profile beside it (WA-027); leads and quotes from this conversation.
- **Take over:** sets the conversation to `human` (the agent stays silent); **reply as a person** sends a WhatsApp message through the channel (the simulator in the demo), marked as sent by that member; **return to bot** hands it back. Assignment to a member.
- **Alerts:** a handoff or a customer message on a `human` conversation notifies the assigned member (else the branch) by email straight away; web push on the installed dashboard (PWA) where the phone allows it.

## Acceptance criteria

- [x] During a demo, "falar com uma pessoa" in the simulator shows up in the inbox within 2 seconds, a salesperson takes over and replies from a phone, and the reply appears in the simulator chat.
- [x] After "return to bot", the agent answers the next customer message with the person's replies in its history.

## Out of scope

Canned replies, internal chat between colleagues, the 24-hour WhatsApp window rules (WA-030).

## Implementation notes

- **API** (`apps/api/src/admin/inbox/`, mounted at `/api/admin/clients/:clientId/inbox`): `GET /` (`?view=human|mine|all&branch=`), `GET /stream` (SSE, `?access_token=`), `GET /:id` (transcript with the WhatsApp payloads, so product cards, buttons, lists, taps and images can be drawn; the conversation's leads, handoffs and order drafts; members it can be assigned to), `POST /:id/read`, `/takeover` (status `human`, assigned to me), `/assign` (`{ memberId | null }`, only members who work with the branch, or admins), `/reply` (`{ text }`), `/bot`. Types in `packages/shared/src/inbox.ts`.
- **Schema** (`db/schema.ts`, marked WA-023): `conversations.branch_id` (set by `handoff_to_human`, or from the first lead), `conversations.assigned_member_id`, `conversations.team_read_at` (unread badge: customer messages after it and after the last reply), index `(client_id, last_activity_at)`; `messages.sent_by_member_id`.
- **Scoping:** admins see everything; sales see their branches' conversations plus any assigned to them. A conversation with no branch yet (the bot never handed it over nor saved a lead) is visible to admins only.
- **Replies** go through `MessageService.send`, i.e. the client's Channel: the simulator chat gets them on its SSE stream. Replying to a bot conversation takes it over first so the agent and the person never both answer. `processConversation` now returns before "typing…" when the conversation is `human`, and marks the messages as processed.
- **History:** `agent/history.ts` prefixes a member's reply with `[Sent by a colleague from the team, not by you]`; the system prompt tells the agent to continue from it after the hand-back (tested end to end with the Claude responder).
- **Live updates:** `EventBus.subscribeAll`; `InboxService` listens to the chat bus (messages) and the back-office bus (status, leads), reloads the conversation's list row and publishes it on its own bus; the stream filters rows by the member's scope. Status changes from the inbox also go to the simulator's back-office panel (`publishStatus`), and the panel's "Devolver ao bot" updates the inbox. In the demo, a "falar com uma pessoa" in the simulator showed up in the inbox after ~0.8 s.
- **Alerts:** on a handoff, or a customer message on a `human` conversation, an `inbox_alert` email (pt-PT, link to the conversation) goes through the Mailer to the assigned member, else the branch's members (`TeamService.ofBranch`), else the admins; none when nobody is on the team. Customer messages are throttled to one email per conversation and recipients per 10 minutes. Assigning someone else emails them. The agent's own handoff email (WA-016) to the branch address is unchanged.
- **Dashboard** (`apps/admin/src/app/features/inbox/`): `InboxStore` (provided by the feature routes) with filters, unread badges, a "precisam de pessoa" count and the EventSource stream (reconnects with a fresh token URL); list and conversation are separate screens on phones and a split view from 900 px. Conversation: transcript with agent / member / customer bubbles, taps and offered buttons/lists, lead cards, take over / return to bot, assignment, reply box (Enter sends on a computer).
- Screenshots in `/mnt/project-files/m5/`: `wa023-inbox-list-mobile.png`, `wa023-inbox-conversation-mobile.png`, `wa023-inbox-reply-sent-mobile.png`, `wa023-inbox-split-desktop.png`, `wa023-inbox-split-desktop-live.png`, `wa023-simulator-reply.png`.

## Open items

- Web push (PWA) not done: alerts are email only.
- The customer's record and profile beside the conversation is WA-027's; the view shows name, phone, branch and leads for now.
- Inbound images show as "Enviou uma imagem" (no media download yet).
- No nav badge for waiting conversations (would touch the shared shell).
