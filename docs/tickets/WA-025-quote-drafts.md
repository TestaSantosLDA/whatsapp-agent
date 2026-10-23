# WA-025: Quote drafts from the conversation

| Status    | Milestone | Depends on             | PR  |
| --------- | --------- | ---------------------- | --- |
| in review | M5        | WA-024, WA-012, WA-026 |     |

## Why

The agent has already collected the products, the area and the quantities. Turning that into a quote should take a salesperson two minutes, not twenty.

## Scope

- From a lead, **Create quote** prefills lines from what the agent gathered (products and variants from the catalogue, quantities from the calculator, delivery or pickup, customer details).
- The salesperson edits lines, prices and discounts (per line or total), validity date and notes; totals with IVA are computed by code.
- **PDF** with the client's letterhead, logo, legal details and conditions (from config), numbered per client and year (e.g. `JUL-2026-0042`).
- **Send** by email to the customer from the dashboard, or as a document in the WhatsApp conversation; the lead moves to `quoted`.
- The agent can tell a customer the status of their quote ("foi-lhe enviado ontem pela equipa da Maia").

## Acceptance criteria

- [x] From a demo deck lead, a quote PDF with correct quantities and totals is produced and delivered to the simulator chat in under two minutes of clicks.
- [x] Line totals, discounts and IVA are computed by tested code, never by the model.

## Out of scope

Invoices, payments, stock reservation, ERP integration (PHC / Primavera), e-signature.

## Notes

Needs from Jular: letterhead, legal footer, quote conditions, numbering preference, who may give which discounts.

## Implementation (2026-10-23)

**Totals by code.** [packages/shared/src/quotes.ts](../../packages/shared/src/quotes.ts): `computeQuoteTotals(lines, discount)` on scaled integers (BigInt): quantity (3 dp) × net unit price (4 dp) rounded half up to the cent per line, line discount %, then a global discount (% or € on the net subtotal, never more than it), IVA per rate on the discounted base (the global discount is spread over rates by largest remainder), total. The API computes it for what it stores and prints; the dashboard runs the same function live while editing; whatever totals a browser sends are ignored. `netFromGross` turns catalogue prices (IVA included) into 4-dp net prices (25,00 € → 20,3252 €), so a calculator total comes back to the cent (27 × 71,88 € = 1 940,76 €). Several lines of rounded net prices can differ from the store's IVA-included sum by a cent (e.g. 3 × 25 € + 2 × 12,30 € → 99,61 €); that is how a net-priced quote rounds. Zod schemas limit decimals and ranges, with pt-PT messages.

**Data** (`db/schema.ts`, "WA-025"): `quotes` (lead, conversation, contact, branch, `number` unique per client, `draft|sent`, customer / lines / discount JSON, validity, delivery, notes, `total_cents`, `sends` `[{ channel, to, at, by }]`, `public_token`, who and when), `quote_pdfs` (the sent PDF's bytes, `bytea`) and `quote_counters` (client, year, last), incremented with one atomic upsert. Numbers are `<prefix>-<year>-<seq>` (`JUL-2026-0042`), year in the client's time zone; a deleted draft's number is not reused. Lead event kind `quote_sent` (`{ quoteId, number, channel, totalCents }`). Email kind `quote`, with `attachments` on `Email` (Resend gets them base64). Outbound message type `document` (Meta's shape) in `MetaSendMessage` / `OutboundMessage`.

**Config** (`clients/<id>.yaml` `quotes:`): `prefix`, `number_digits`, `validity_days`, `vat_percent`, `company` (legal name, NIF, address, phone, email, website), `logo_url` (PNG/JPEG, fetched once through the injected `fetch`; a failing logo is left out), `conditions` (lines), `footer`. Jular's values are placeholders from its site (prefix `JUL`, 23 %, 30 days, conditions from its policies).

**Prefill** ([admin/quotes/prefill.ts](../../apps/api/src/admin/quotes/prefill.ts)): an order draft's catalogue items at today's catalogue price, its items outside the catalogue (price 0), then the quantity calculator's results in the lead's conversation: each `calculate_quantity` call recorded in `agent_runs` is **run again** from its input (boxes, box price), never read back from what the model wrote; latest per product. Without lines, one line with the products the agent noted (quantity = area in m², price 0). Customer name, company, NIF, email, phone, address; pickup or delivery from an order draft; validity = today + `validity_days`.

**API** (`/api/admin/clients/:clientId/quotes`, [admin/quotes](../../apps/api/src/admin/quotes/)): `GET ?lead=`, `POST { leadId }` (201, prefilled), `GET /:id`, `PUT /:id` (drafts only, 409 once sent), `DELETE /:id` (drafts), `GET /:id/pdf` (a "Rascunho" preview for drafts, the sent file otherwise), `POST /:id/send { channel: whatsapp|email, email?, message? }`. Scoped by client and the lead's branch (`assertBranch`). The first send renders the final PDF once, stores it, locks the quote and makes a public token; later sends (other channel, again) deliver the same file. WhatsApp: a `document` message in the lead's conversation, linking to `GET /static/quotes/<token>/<file>.pdf` (public, unguessable 192-bit token, `no-store`, `noindex`; under `/static` so the simulator's dev proxy already serves it). Email: to the quote's email (or one typed), reply-to the salesperson, PDF attached; goes through the outbox like every email (`MAIL_REDIRECT_TO` applies). Then the lead moves to `quoted` through `LeadsService.setStatus` (only from `new`/`contacted`; won/lost stay) and gets a `quote_sent` event.

**PDF** ([admin/quotes/pdf.ts](../../apps/api/src/admin/quotes/pdf.ts)): `pdf-lib` 1.17.1 (MIT, pure JS, standard Helvetica, nothing downloaded), behind a `QuotePdfRenderer` interface injected into `QuotesService` (`AppDeps.quotePdf` for tests). A4: letterhead (logo or name, legal details), title, number, date, validity, branch, customer box and delivery, a table (ref., description, qty, unit, net unit price, discount, IVA, line total) that wraps text and runs onto more pages with its header repeated, totals with IVA per rate, notes, conditions (validity first), legal footer and "Página x de y" on every page. Characters Helvetica cannot draw lose their accents or become "?".

**Privacy**: `quotesHandler` (tables `quotes`, `quote_pdfs`) in `privacy/handlers.ts`: export lists the quotes and adds their PDFs to the ZIP (`media/quotes/quotes/Orcamento-….pdf`); delete keeps number, lines, totals and dates, and removes the customer, notes, delivery, recipients, the PDF and the public link.

**Dashboard** (`apps/admin/src/app/features/quotes`, route `/quotes/:id`, not in the nav): an "Orçamentos" card on the lead page (list + **Criar orçamento**), and the quote editor: lines (description, qty, unit, net price, discount %, IVA %, line total), add/remove lines, delivery, validity, global discount (none / % / €), notes, customer, live totals, Guardar, Ver PDF (opens the PDF), **Enviar por WhatsApp**, **Enviar por email** (address editable), sends list; locked (read-only) once sent. Unsaved edits are saved before a preview or a send. Simulator: document bubbles (icon, file name, link, caption); back-office label for `quote` emails.

**Demo** (acceptance): from the deck lead (30 m² of Deck Cumaru, calculator in the conversation), two taps, "Criar orçamento" then "Enviar por WhatsApp", put `Orcamento-JUL-2026-0001.pdf` (27 cx × 58,439 € + 23 % = 1 940,76 €) in the simulator chat; the scripted run took about 2 s. The end-to-end API test does the same with a scripted agent turn (calculate_quantity, save_lead).

**Tests.** Shared: totals (rounding, line and global discounts, amount capped, several IVA rates and the discount split, empty quote, fractional quantities), `netFromGross`, schemas, formatting. API: prefill from an order draft (catalogue price, missing product, items outside the catalogue, pickup, NIF), fallback line, numbering, server-side totals and validation, branch and client scoping, email send (outbox, lead `quoted`, events, lock), missing email and empty quote, PDF content (letterhead, customer, lines, totals, conditions, footer, draft mark, replaced characters), multi-page PDF, totals block, Resend attachment, the end-to-end deck demo (agent turn → quote → WhatsApp document → public PDF → lead quoted; resending; a won lead stays won), privacy export and delete. Dashboard: helpers, create from the lead card, live totals while editing, save, add/remove lines, send by WhatsApp (save first, then lock), send by email. Simulator: document bubble.

**Screenshots** (`/mnt/project-files/m5/`): `wa025-lead-quotes-mobile.png`, `wa025-quote-editor-mobile.png`, `wa025-quote-editor-mobile-full.png`, `wa025-quote-sent-mobile.png`, `wa025-quote-desktop.png`, `wa025-simulator-document.png`, `wa025-quote-pdf-1.png` and the PDF itself, `wa025-quote-JUL-2026-0001.pdf`.

**Open items.**

- From Jular: letterhead and logo URL, legal name, NIF and footer, conditions, numbering preference; then fill `quotes:` in `clients/jular.yaml`.
- Who may give which discounts: not enforced yet (any member of the branch can set any discount). A `max_discount_percent` per role would go in `quotes:` and be checked in `QuotesService.update`.
- The agent telling a customer about their quote: a quote sent by WhatsApp is in the conversation history (the document's caption), so the agent sees it; a quote sent only by email is not. A small `quote_status` tool reading `quotes` by contact would cover both.
- Sent quotes are locked; changing one means a new quote (new number). No versions ("rev. 2") yet.
- On real WhatsApp (WA-030), sending a document outside the 24-hour window needs a template.
- After the M5 merges: a quote sent by WhatsApp is stored with `sent_by_member_id` (the inbox shows who sent it, the agent's history marks it as a colleague's message, and it counts as the team's first response in the overview); the overview's `quotesSent` counts sent quotes.
