# WA-029: Overview and "couldn't answer" list

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| todo   | M5        | WA-022, WA-024 |     |

## Why

Management wants to know what the agent brings in, and the team needs to know what to teach it next.

## Scope

- **Overview:** this week and month per branch: conversations, leads by type, handoffs, quotes sent, won/lost, median first response by the team, Claude cost.
- **Couldn't answer:** questions where the agent said it would check with a colleague, handed over for lack of information, or a tool found nothing; grouped by topic with examples and counts, each with "upload a document" (WA-026) or "dismiss".
- **Most asked products** and searches with no result (products customers want that are not in the store).
- **Weekly email** to admins every Monday with these numbers and the top five gaps.

## Acceptance criteria

- [ ] After the eval set runs against a demo client, the overview numbers match the database (tests) and the "couldn't answer" list shows the cases where the agent deferred.

## Out of scope

Custom reports, BI exports beyond CSV.
