# WA-010: Product search and details tools

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M2        | WA-008, WA-009 |     |

## Why

Use case 1, the product advisor: customers describe a need and get two or three real products.

## Scope

- `search_products`: query text plus optional filters (category or product type, brand, max price, in stock only, thickness, use such as bathroom or exterior). Postgres full-text search over title, type, tags and description. Returns at most 8 compact results.
- `get_product`: full details for one product or variant, including link, image, price per unit, availability and extras from config.
- Reply formatting: recommendations sent as image + caption + link, or as a list message when there are more than three.

## Acceptance criteria

- [x] "Preciso de pavimento para uma casa de banho" returns vinyl or water-resistant options, not solid wood. Tested on fixture data; how well it works on Jular's catalogue depends on their product descriptions mentioning the use.
- [x] "Do you have Osmo oil?" returns Osmo products with prices.
- [x] Out-of-stock products are flagged as such and not recommended first.
- [ ] Eval cases for these added to WA-019. (WA-019 is not started.)

## Implementation

- `apps/api/src/catalogue/repository.ts`: `searchProducts` runs `websearch_to_tsquery` with both the 'portuguese' and 'simple' configs. Rows matching every word come first; if none do, rows matching any word; then ILIKE on the title (for parts of words or queries without words). Available rows sort first, then an exact SKU match, then `ts_rank`. Also `getProduct`, `getProductVariants` and `getVariants`.
- Tools in `apps/api/src/agent/tools/`:
  - `search_products`: at most 8 compact results. `use` (e.g. "casa de banho") is added to the query.
  - `get_product`: full details, extras and the other variants. `show_to_customer` also queues the photo card.
  - `show_products`: 1-3 products are sent as image cards (text when there is no image); 4-10 as one list message within WhatsApp limits (row title 24, description 72, 10 rows). A tapped row comes back as `product:<variant_id>`.
- Thickness has no filter of its own: it goes in the query text ("10 mm"), since it lives in titles and descriptions rather than a structured field.
- Search ignores accents only through Portuguese stemming: "oleo" does not match "óleo". Adding `unaccent` to the search vector would mean a migration; it waits until real queries show the need.
