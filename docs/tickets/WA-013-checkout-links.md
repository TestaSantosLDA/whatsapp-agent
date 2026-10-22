# WA-013: Checkout links

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M2        | WA-010     |     |

## Why

Closing the sale inside the chat. Shopify cart permalinks let us do it without admin access.

## Scope

- `create_checkout_link` tool: list of `{variant_id, quantity}` → `https://<store>/cart/<variant_id>:<qty>,<variant_id>:<qty>`.
- Validate every variant exists and is available in the synced catalogue before building the link.
- Agent shows a summary (items, quantities, total) and asks for confirmation before sending the link.
- Rules from config: products flagged special transport, delivery to the islands or abroad, or showroom-only items → do not send a link; use `send_order_draft` (WA-016) instead.
- Optional: `?ref=whatsapp-agent` or a discount code parameter if the client wants attribution.

## Acceptance criteria

- [ ] Opening a generated link for two Jular products lands on checkout with both items and the right quantities. Needs a live check against loja.jular.pt; the link format is covered by tests.
- [x] An unavailable variant is rejected with a clear tool error.
- [x] A special-transport product never produces a checkout link.

## Implementation

- `create_checkout_link` (`apps/api/src/agent/tools/create-checkout-link.ts`) takes `items: [{ variant_id, quantity }]`. Repeated variants are merged into one line. It returns `{ url, items (unit and line prices), total_eur, note }`.
- Tool errors: `not_found` (unknown variant), `unavailable` (out of stock), `needs_order_draft` (special transport), `not_configured` (client without a Shopify catalogue).
- **Special-transport flag.** A product is special when its Shopify tags include "Transporte Especial" (case, accents and `-`/`_` ignored; "special transport" also works), or when `product_data` sets `special_transport: true` for it (by handle, SKU or variant id). The tag lets Jular flag products in Shopify without us; the config flag covers products they have not tagged. If any item is special the whole order is refused, since Jular's `envio` policy treats the whole order as special.
- Islands and abroad cannot be known from the cart. The tool description tells the agent not to use the tool when the customer mentions Madeira, the Azores or abroad; WA-016's `send_order_draft` takes over.
- Attribution: optional `catalogue.checkout_ref` in the client config adds `?ref=<value>`. Not set for Jular yet.

## Notes

Confirm with Jular how special products are flagged in Shopify (tag, product type or metafield). Until they answer we use the tag "Transporte Especial" plus `product_data`; switching to a product type or metafield is a change to `isSpecialTransport` in `catalogue/repository.ts`.
