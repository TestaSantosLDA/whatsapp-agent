# WA-007: Simulator chat UI (Angular)

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M1 | WA-006 | |

## Why
The simulator is our sales demo. It has to feel like WhatsApp on a phone.

## Scope
- Angular app in `apps/simulator`, standalone components, signals.
- Layout: a phone-sized WhatsApp-style chat in the centre; a top bar to pick the client, customer persona (name and phone) and language; room on the right for the back-office panel (WA-018).
- Renders: text with WhatsApp formatting (`*bold*`, `_italic_`, links), images with captions, reply buttons and list messages that the user can tap, read ticks, typing indicator, timestamps.
- Tapping a button sends the matching interactive reply payload.
- Reset conversation button.
- Works on desktop and on a phone browser.

## Acceptance criteria
- [ ] A person can chat with the echo bot from WA-006 end to end.
- [ ] Buttons, lists and images render and are tappable.
- [ ] Looks recognisably like WhatsApp without using its logo or trademarks.

## Out of scope
Back-office panel (WA-018). Login beyond the access code.
