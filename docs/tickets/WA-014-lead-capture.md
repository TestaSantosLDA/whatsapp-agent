# WA-014: Lead capture and LeadSink

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M3        | WA-009     |     |

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

- [x] A quote request for 120 m² of decking in Faro ends with one lead routed to Albufeira, visible in the DB and the back-office panel (published as a `lead` event; the panel UI is WA-018).
- [ ] With Sheets configured, the same lead appears as a new row with all fields. The request (signed JWT, RAW append, row values) is covered by tests with a fake Google; needs a live check with a real sheet and service account.
- [x] The customer gets a confirmation saying who will contact them and roughly when (from config, not invented).

## Implementation

- **Config** (`packages/shared/src/client-config.ts`, backward compatible): `lead.required_fields` is now an enum of the fields `save_lead` knows (`name, email, location, request_type, business_line, products, area_m2, timeline`); `lead.sinks` (`[db]` by default, `sheets` optional) with `lead.sheets: { spreadsheet_id, sheet_name }` (required when `sheets` is listed, checked at load); `lead.order_branch` (WA-016); per-branch `lead_emails` (WA-015).
- **Routing** (`apps/api/src/leads/routing.ts`): `routeBranch(client, { location, business_line })`. Business line rules first, then region rules matched as whole words in the location, case and accent insensitive ("Loulé, FARO" → Faro; "Farol" does not match), else `routing.default_branch`.
- **Sinks** (`apps/api/src/leads/`): `LeadSink { name, write(lead) }`. `DbLeadSink` inserts the `leads` row and publishes it to the back-office (this is the MockLeadSink role: the panel sees each lead as it is stored). `GoogleSheetsLeadSink` appends one row through `spreadsheets.values.append` with a service account: an RS256 JWT signed with `node:crypto`, exchanged for an access token that is cached; no new dependency. `LeadSinks.save()` writes the database first (the tool fails if that fails), then the client's other sinks in the background with retries, so the sheet never delays or fails the reply. Sheet columns are in `SHEET_COLUMNS`; fields without a column go to a JSON "Outros dados" column.
- **`save_lead` tool** (`apps/api/src/agent/tools/save-lead.ts`): `request_type, name, email, location, business_line, products, area_m2, timeline, summary, branch_id?`. Missing required fields → tool error `missing_fields` listing them with what to ask; the prompt tells the agent to ask one or two at a time and to confirm before saving. The phone comes from the contact. Images, documents and videos the customer sent in the conversation are attached automatically (message and media ids). It emails the branch (WA-015) and returns `{ branch, response_time, tell_customer }`.

## Decisions

- The WhatsApp profile name counts as `name` when the customer gives none, so the agent does not ask for a name WhatsApp already shows. A name the customer gives wins.
- Sheets values are appended with `valueInputOption=RAW`, so customer text such as `=HYPERLINK(...)` is never evaluated as a formula.
- A lead has one id across sinks (chosen before the first write), so a sheet row can be matched to its DB row.

## Open items

- Jular has not shared a sheet yet: `jular.yaml` has `sinks: [db]` and a commented `sheets` block. Put the `SHEET_COLUMNS` headers in the sheet's first row and share it with the service account's email as an editor.
- `GOOGLE_SERVICE_ACCOUNT_JSON` holds the key file contents; on Cloud Run it should come from Secret Manager (WA-020).
- Calling `save_lead` twice in a conversation stores two leads; deduplication can come later if it happens in practice.
