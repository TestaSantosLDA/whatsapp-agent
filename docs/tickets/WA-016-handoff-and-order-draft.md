# WA-016: Handoff to human and order drafts

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M3        | WA-014, WA-015 |     |

## Why

Use case 5, and the fallback for orders that cannot go through a checkout link.

## Scope

- `handoff_to_human` tool: reason, urgency, summary. Sets the conversation to `human`, notifies the routed branch (email), and tells the customer when to expect a reply based on that branch's opening hours.
- Triggers: the customer asks for a person; repeated misunderstanding; complaints; large or complex projects (rules in config).
- While in `human` status the bot stays silent. A command from the back-office panel (and later the real dashboard) returns the conversation to `bot`.
- `send_order_draft` tool: cart items, quantities, delivery address or pickup, customer details. Emails the draft to the sales team, stores it as a lead of type `order`, and tells the customer the team will confirm price and transport.

## Acceptance criteria

- [x] "Quero falar com alguém" at 22:00 → handoff, customer told the team replies after 9:00, email in outbox.
- [x] After handoff, new customer messages get no bot reply.
- [x] A cart with a special-transport product produces an order draft, not a checkout link.

## Implementation

- **`handoff_to_human`** (`apps/api/src/agent/tools/handoff-to-human.ts`) replaces `request_human` and is always on, with `offer_choices`. Input: `reason` (customer_asked, complaint, repeated_misunderstanding, needs_decision, large_project, could_not_help, other), `urgency` (normal, high), `summary`, optional `branch_id`, `location`, `business_line` (routed with `routeBranch` when no branch is given). It stores a `handoff` lead, sets the conversation to `human`, publishes the status, emails the branch, and returns `open_now`, `next_opening` and a `tell_customer` line ("closed now… a colleague will reply here after it opens, tomorrow (Wednesday) at 09:00").
- `nextOpening(branch, now, tz)` in `apps/api/src/agent/hours.ts`: the next opening time within a week, safe across DST changes. Tools get the turn's time through `ToolContext.now`.
- The code-level guardrail ("falar com uma pessoa", "talk to a human") now calls `handoff_to_human` when Claude did not.
- Config `handoff.triggers`: extra handoff situations added to the system prompt (Jular: site visits or meetings, floors or decks above 300 m²; to confirm).
- **Silence and return to bot.** The job already skips the responder in `human` status. `POST /sim/:clientId/conversation/bot?phone=` (simulator clients only, behind the access code) sets the open conversation back to `bot` and publishes the status to the back-office. Messages received while in `human` are marked processed, so the bot does not answer them later. The job failure handler (apology + `human`) now also publishes the status.
- **`send_order_draft`** (`apps/api/src/agent/tools/send-order-draft.ts`): `items [{variant_id, quantity}]` validated against the synced catalogue, `other_items` for showroom-only products, `reason` (special_transport, islands_or_abroad, showroom_only, other), `fulfilment` delivery (`delivery_address`) or pickup (`pickup_branch_id`), `name`, `email`, `nif`, `notes`, `summary`. Stores a lead of type `order` with the priced lines and the products subtotal, emails the draft (to the pickup branch, else `lead.order_branch`, else the default branch), and returns what to tell the customer: the team confirms price and transport; nothing is charged until they accept.
- The prompt's handoff section names the new tool, and new short sections cover leads (ask only missing required fields, one or two at a time, confirm before saving) and order drafts (when `create_checkout_link` returns `needs_order_draft`, islands or abroad, showroom-only items).

## Open items

- The panel button for "return to bot" is WA-018 (another branch adds the SSE route and UI); the API route is here.
- The failure handler does not store a handoff lead or send an email; a technical failure only shows in the panel's turn trace.
- Out-of-stock catalogue items are allowed in an order draft and flagged in the email ("Esgotados online"); the team decides.

## Notes

In real WhatsApp mode, staff reply from the WhatsApp Business app via coexistence or from a future inbox. Out of scope for the demo.
