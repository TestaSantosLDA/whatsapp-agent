# WA-008: Shopify catalogue sync

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M2        | WA-003     |     |

## Why

The agent must recommend real products with current prices and stock, without Jular building anything.

## Scope

- `CatalogueSource` interface; `ShopifyPublicSource` reads `https://<store>/products.json?limit=250&page=N` until empty.
- Upsert one row per variant into `products`: product and variant ids, SKU, title, product type, vendor, tags, price, compare-at price, available, product URL, first image URL, plain-text description.
- Mark rows missing from the latest sync as unavailable instead of deleting them.
- Merge `product_data` extras from client config (e.g. m² per box).
- Run on startup, hourly via Cloud Scheduler (`POST /jobs/catalogue-sync`), and from a `pnpm sync:catalogue` script.

## Acceptance criteria

- [ ] Full Jular sync stores every product in the feed; a second run changes nothing. Covered by tests against a two-page fixture feed (second run reports every row unchanged and writes nothing); still to be checked live against loja.jular.pt, which the dev container cannot reach.
- [x] A price change in the feed is reflected after the next sync.
- [x] Sync failure keeps the previous catalogue and logs the error.

## Implementation

- `apps/api/src/catalogue/source.ts`: `CatalogueSource` and `ShopifyPublicSource`. The feed is validated with Zod (only the fields we use); the description is plain text from `body_html`; the image is the variant's own one, else the first product image.
- `apps/api/src/catalogue/sync.ts`: `syncCatalogue` and `syncClients`. Returns `{ ok, inserted, updated, unchanged, markedUnavailable }` or `{ ok: false, error }`.
  - Rows whose fields did not change are not written, so `synced_at` means "last changed".
  - An empty feed while the catalogue has available rows counts as a failure (more likely an outage than an empty shop).
  - `product_data` keys may be a product handle, a SKU or a variant id; per field the most specific wins (variant id > SKU > handle). The result goes in `extra`.
- `POST /jobs/catalogue-sync[?client=<id>]` (`apps/api/src/routes/jobs.ts`), protected by the `x-jobs-secret` header matching `JOBS_SECRET`; 503 while it is unset, 502 when any sync failed so Cloud Scheduler retries. The Cloud Scheduler job itself is set up in WA-020.
- Startup sync in `server.ts` runs in the background; `pnpm sync:catalogue [client…]` runs it by hand.

## Notes

- Prices in the feed include VAT (23%); the store also shows prices per m² + IVA. Confirm with Jular which unit each flooring variant is sold in (box or m²).
- WooCommerce and CSV sources come with the next client that needs them.
