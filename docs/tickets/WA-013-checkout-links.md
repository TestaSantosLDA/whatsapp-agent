# WA-013: Checkout links

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M2        | WA-010     |     |

## Why

Closing the sale inside the chat. Shopify cart permalinks let us do it without admin access.

## Scope

- `create_checkout_link` tool: list of `{variant_id, quantity}` → `https://<store>/cart/<variant_id>:<qty>,<variant_id>:<qty>`.
- Validate every variant exists and is available in the synced catalogue before building the link.
- Agent shows a summary (items, quantities, total) and asks for confirmation before sending the link.
- Rules from config: products flagged special transport, delivery to the islands or abroad, or showroom-only items → do not send a link; use `send_order_draft` (WA-016) instead.
- Optional: `?ref=whatsapp-agent` or a discount code parameter if the client wants attribution.

## Acceptance criteria

- [ ] Opening a generated link for two Jular products lands on checkout with both items and the right quantities.
- [ ] An unavailable variant is rejected with a clear tool error.
- [ ] A special-transport product never produces a checkout link.

## Notes

Confirm with Jular how special products are flagged in Shopify (tag, product type or metafield).
