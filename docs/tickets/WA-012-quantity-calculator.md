# WA-012: Quantity and price calculator

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M2        | WA-010     |     |

## Why

Use case 2. "How many boxes for 35 m²?" is the most common pre-sale question for flooring and decking, and it leads straight to a cart.

## Scope

- `calculate_quantity` tool: inputs are product or variant, area in m² (or room dimensions), waste margin (default 7%, 10% for diagonal laying), optional perimeter for skirting.
- Output: units to buy (rounded up to whole boxes), area covered, total price, plus suggested accessories (underlay, skirting metres, profiles) when the product type calls for them.
- Deterministic code, not the model, does the maths.
- Uses `product_data.m2_per_box` from config; when missing, the tool says so and the agent offers a human instead of guessing.

## Acceptance criteria

- [x] Unit tests: 35 m² at 2.22 m²/box with 7% waste → 17 boxes.
- [x] Room "4 x 5 m" is converted to 20 m².
- [x] Product without box data → tool returns `missing_data` (its message tells the agent not to guess and to offer a colleague).
- [ ] Agent does not invent a number when the tool returns `missing_data`. The tool is registered and enabled for Jular; still to check with an eval case in WA-019.

## Notes

- Maths in `apps/api/src/calculator/quantity.ts` (pure, BigInt on scaled integers: 1/10 000 m², basis points, cents). Tool in `apps/api/src/agent/tools/calculate-quantity.ts`, registered in `apps/api/src/agent/registry.ts`.
- Per-variant data is read from `products.extra` (`m2_per_box`, `price_unit: box | m2`, default `box`), with a fallback to client `product_data` keyed by SKU.
- Prices are VAT included. With `price_unit: m2` the total is the m² price × the area the whole boxes cover.
- `rooms` accepts "4 x 5", "4,5 x 3,2", cm, and several rooms or m² amounts summed; the perimeter for skirting is derived from the rooms when not given.
- Accessories are hints with quantities (underlay m², skirting = perimeter + 5%, profiles per doorway; decking ≈ 25 clips/m² and 3 m joist/m²), not catalogue products. The decking ratios are rule-of-thumb figures to confirm with Jular.

Needs m² per box from Jular for each flooring and deck product.
