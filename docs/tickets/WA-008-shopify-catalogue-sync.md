# WA-008: Shopify catalogue sync

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M2        | WA-003     |     |

## Why

The agent must recommend real products with current prices and stock, without Jular building anything.

## Scope

- `CatalogueSource` interface; `ShopifyPublicSource` reads `https://<store>/products.json?limit=250&page=N` until empty.
- Upsert one row per variant into `products`: product and variant ids, SKU, title, product type, vendor, tags, price, compare-at price, available, product URL, first image URL, plain-text description.
- Mark rows missing from the latest sync as unavailable instead of deleting them.
- Merge `product_data` extras from client config (e.g. m² per box).
- Run on startup, hourly via Cloud Scheduler (`POST /jobs/catalogue-sync`), and from a `pnpm sync:catalogue` script.

## Acceptance criteria

- [ ] Full Jular sync stores every product in the feed; a second run changes nothing.
- [ ] A price change in the feed is reflected after the next sync.
- [ ] Sync failure keeps the previous catalogue and logs the error.

## Notes

- Prices in the feed include VAT (23%); the store also shows prices per m² + IVA. Confirm with Jular which unit each flooring variant is sold in (box or m²).
- WooCommerce and CSV sources come with the next client that needs them.
