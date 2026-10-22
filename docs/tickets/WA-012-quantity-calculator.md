# WA-012: Quantity and price calculator

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M2        | WA-010     |     |

## Why

Use case 2. "How many boxes for 35 m²?" is the most common pre-sale question for flooring and decking, and it leads straight to a cart.

## Scope

- `calculate_quantity` tool: inputs are product or variant, area in m² (or room dimensions), waste margin (default 7%, 10% for diagonal laying), optional perimeter for skirting.
- Output: units to buy (rounded up to whole boxes), area covered, total price, plus suggested accessories (underlay, skirting metres, profiles) when the product type calls for them.
- Deterministic code, not the model, does the maths.
- Uses `product_data.m2_per_box` from config; when missing, the tool says so and the agent offers a human instead of guessing.

## Acceptance criteria

- [ ] Unit tests: 35 m² at 2.22 m²/box with 7% waste → 17 boxes.
- [ ] Room "4 x 5 m" is converted to 20 m².
- [ ] Product without box data → tool returns `missing_data`, agent does not invent a number.

## Notes

Needs m² per box from Jular for each flooring and deck product.
