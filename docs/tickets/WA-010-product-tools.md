# WA-010: Product search and details tools

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M2 | WA-008, WA-009 | |

## Why
Use case 1, the product advisor: customers describe a need and get two or three real products.

## Scope
- `search_products`: query text plus optional filters (category or product type, brand, max price, in stock only, thickness, use such as bathroom or exterior). Postgres full-text search over title, type, tags and description. Returns at most 8 compact results.
- `get_product`: full details for one product or variant, including link, image, price per unit, availability and extras from config.
- Reply formatting: recommendations sent as image + caption + link, or as a list message when there are more than three.

## Acceptance criteria
- [ ] "Preciso de pavimento para uma casa de banho" returns vinyl or water-resistant options, not solid wood.
- [ ] "Do you have Osmo oil?" returns Osmo products with prices.
- [ ] Out-of-stock products are flagged as such and not recommended first.
- [ ] Eval cases for these added to WA-019.
