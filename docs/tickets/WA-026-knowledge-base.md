# WA-026: Knowledge base: drop files, approve extracted data

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M5        | WA-022     |     |

## Why

The best answers live in technical sheets, price lists and catalogues the team already has. The agent is missing data the store feed does not have (m² per box), and the team should be able to fix that themselves.

## Scope

- **Upload** PDF, XLSX/CSV, DOCX and images (admins); files stored per client in object storage (Supabase Storage free tier), with a size limit.
- **Extraction:** Claude reads each file and proposes structured product data (m² per box, dimensions, weight, special transport, finishes) matched to catalogue products by SKU or name. Proposals show the source page and wait for an admin to approve, edit or reject; approved values feed `product_data` (WA-008) without editing YAML.
- **Document search:** approved documents are split into passages; a new agent tool `search_documents` finds passages for technical questions, and the agent cites the document by name ("segundo a ficha técnica do deck de cumaru…").
- File list with status (processing, needs review, live), replace and delete.

## Acceptance criteria

- [ ] Uploading a technical sheet with m² per box for a demo flooring product produces a proposal; once approved, the calculator (WA-012) uses it in the next conversation.
- [ ] A technical question answered only by an uploaded document is answered correctly, naming the document, in an eval case (WA-019).

## Out of scope

Crawling jular.pt automatically, OCR of handwritten notes, versioned documents.
