# WA-026: Knowledge base: drop files, approve extracted data

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M5        | WA-022     |     |

## Why

The best answers live in technical sheets, price lists and catalogues the team already has. The agent is missing data the store feed does not have (m² per box), and the team should be able to fix that themselves.

## Scope

- **Upload** PDF, XLSX/CSV, DOCX and images (admins); files stored per client in object storage (Supabase Storage free tier), with a size limit.
- **Extraction:** Claude reads each file and proposes structured product data (m² per box, dimensions, weight, special transport, finishes) matched to catalogue products by SKU or name. Proposals show the source page and wait for an admin to approve, edit or reject; approved values feed `product_data` (WA-008) without editing YAML.
- **Document search:** approved documents are split into passages; a new agent tool `search_documents` finds passages for technical questions, and the agent cites the document by name ("segundo a ficha técnica do deck de cumaru…").
- File list with status (processing, needs review, live), replace and delete.

## Acceptance criteria

- [x] Uploading a technical sheet with m² per box for a demo flooring product produces a proposal; once approved, the calculator (WA-012) uses it in the next conversation.
- [ ] A technical question answered only by an uploaded document is answered correctly, naming the document, in an eval case (WA-019).

## Out of scope

Crawling jular.pt automatically, OCR of handwritten notes, versioned documents.

## Implementation (2026-10-23)

**Storage.** `FileStore` ([knowledge/file-store.ts](../../apps/api/src/knowledge/file-store.ts)): `SupabaseStorageFileStore` (Storage REST API with the service role key, private bucket `STORAGE_BUCKET`, default `knowledge`, created on the first upload) and `LocalFileStore` (`FILE_STORE_DIR`, default `data/files`); `MemoryFileStore` for tests. `FILE_STORE=supabase|local` picks one; unset, Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. Keys are `<clientId>/<documentId>/<filename>` (name made safe). Uploads: PDF, XLSX, CSV, DOCX, PNG/JPG, at most 20 MB, checked by extension and magic bytes (a renamed file is refused with 415).

**Schema** (`db/schema.ts`, under "WA-026"): `documents` (status `processing | needs_review | live | failed`, `version` bumped on replace so a stale job cannot overwrite, model/tokens/`cost_usd` of the extraction), `document_passages` (page/sheet chunk/section, label, text, generated `tsvector` column: `portuguese` weighted A plus `simple` B, GIN index; works on PGlite, no fallback needed), `product_data_proposals` (product key + label, field, value, edited value, confidence, quote, page, status `pending | approved | edited | rejected`, decided_by/at), `product_data_overrides` (client, product key = handle/SKU/variant id, field, value; unique per client/key/field).

**Pipeline.** Upload enqueues `process_document` on the app queue (in process locally, Cloud Tasks in production; final failure marks the document `failed` with a pt-PT message). CSV (`;`, tab or `,` detected) and XLSX (`read-excel-file`) are split locally into passages of 25 rows written as "Header: value · …"; DOCX through `mammoth` into ~1500-character sections. PDFs go to Claude as a `document` block and images as an `image` block; Claude also transcribes their pages, which become the passages. `DocumentExtractor` uses `messages.parse` + `zodOutputFormat` (like the eval grader) with the client's catalogue (variant id | SKU | handle | title) in a cached system prompt, and returns proposals for `m2_per_box`, `dimensions`, `weight_kg`, `special_transport`, `finishes`; values are coerced (`coerceProductField`), matched to the catalogue (variant id, SKU, handle) and deduplicated. Model: `KNOWLEDGE_MODEL` or the client's model; usage and estimated cost are stored on the document. Without `ANTHROPIC_API_KEY`, spreadsheets and Word files go live as search-only and PDFs/images fail with a message. A document with proposals waits in `needs_review`; with none (or once all are decided) it is `live`.

**Approval → catalogue.** Approving (as proposed, edited, or with another product) upserts `product_data_overrides` and rewrites the affected `products.extra` at once (`catalogue/overrides.ts`); the catalogue sync merges YAML `product_data` and then the overrides (DB > YAML; variant id > SKU > handle within each). Rejecting an approved proposal removes its override. So the calculator (WA-012) and product tools see an approved m² per box from the next turn, without a sync.

**Search.** `search_documents` tool (registered, enabled in `clients/jular.yaml`, one prompt line when enabled): Postgres FTS over passages of the client's **live** documents only; passages matching every term first, any term as a fallback; returns document title (without extension), page and text, and tells the agent to cite the document by name.

**Admin API** `/api/admin/clients/:clientId/knowledge` (everyone reads, `requireAdmin` for the rest): `GET/POST /documents` (multipart field `file`), `GET/PUT/DELETE /documents/:id` (`?removeData=true` also removes data approved from it), `POST /documents/:id/proposals` (bulk approve/reject; approve skips proposals without a catalogue product), `POST /proposals/:id` (approve with optional `value`/`productKey`, or reject). Types in `packages/shared/src/knowledge.ts`.

**Dashboard** `features/knowledge`: drop zone (admins) and list with status (A ler…, Para rever (n), Ativo, Falhou), polling while a file is read; review screen with proposals (value, confidence, quote, current value, approve/edit/reject, bulk) next to the document text, the selected proposal's page highlighted and its quote marked. `AdminApi` now sends `FormData` bodies as multipart.

**Evals.** `evals/jular/setup.json` takes `documents` (passages, seeded as live documents) and `product_overrides` (seeded as approved data) — `seedKnowledge` in the eval runner. New case `faq-wpc-joist-spacing-doc-pt` (joist spacing only in a synthetic WPC technical sheet). The set's upper bound in `evals.test.ts` went from 45 to 46 cases.

**Tests.** `admin/knowledge/knowledge.test.ts`: upload validation (type, empty, renamed file, 21 MB, sales 403, not multipart), storage keys, CSV and tiny-PDF pipelines with a fake Anthropic, no-Claude mode, approve → `calculate_quantity` uses the new m² per box (and survives a sync), DB over YAML, edit/reject/bulk, replace and delete with data, client scoping, search ranking and the tool. `evals.test.ts` checks the seeded sheet is found. Angular: `knowledge.page.spec.ts`.

Screenshots: `/mnt/project-files/m5/wa026-knowledge-list-{mobile,desktop}.png`, `wa026-knowledge-review-{mobile,desktop}.png` (dev login, fake document reader).

### Open items

- The eval case has not been run against Claude here (no API key): run `pnpm eval --client jular --case faq-wpc-joist-spacing-doc-pt` before ticking the second criterion.
- On Cloud Run without `SUPABASE_SERVICE_ROLE_KEY` the local store is the container's disk (lost on restart); production should run with the Supabase store.
- Search covers live documents only: a document waiting for review is not searchable until its proposals are decided.
- No catalogue picker in the review screen yet: an unmatched proposal is assigned by typing a SKU or handle.
