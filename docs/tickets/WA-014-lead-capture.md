# WA-014: Lead capture and LeadSink

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M3        | WA-009     |     |

## Why

Use case 4. For pros, architects and anything not sold online, the agent's job is a complete, well-routed lead. This replaces Jular's web form (info / quote / sample).

## Scope

- `save_lead` tool: request type, name, phone (known from WhatsApp), email (optional), location, business line, products or project description, area in m², timeline, attachments (images or plans the customer sent), conversation summary.
- The agent asks only for missing required fields from client config, one or two at a time.
- Routing: pick the branch from location and business line using config rules.
- `LeadSink` interface with:
  - `DbLeadSink` (always): row in `leads`
  - `MockLeadSink`: event to the back-office panel (WA-018)
  - `GoogleSheetsLeadSink`: appends a row to a configured sheet via a service account
- Sinks configured per client; several can be active at once.

## Acceptance criteria

- [ ] A quote request for 120 m² of decking in Faro ends with one lead routed to Albufeira, visible in the DB and the back-office panel.
- [ ] With Sheets configured, the same lead appears as a new row with all fields.
- [ ] The customer gets a confirmation saying who will contact them and roughly when (from config, not invented).
