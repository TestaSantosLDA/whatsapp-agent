# WA-002: Client config files and Jular config

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M1        | WA-001     |     |

## Why

Everything client-specific lives in config, so the next client is a new file, not new code. This is what makes the product sellable.

## Scope

- `clients/<client-id>.yaml`, validated by a Zod schema in `packages/shared`.
- Fields:
  - identity: `id`, `name`, `brand_voice`, `languages` (e.g. `[pt-PT, en]`), `default_language`
  - `channel`: `{ type: simulator }` or `{ type: whatsapp_cloud, phone_number_id, ... }` (secrets by env var name, never inline)
  - `catalogue`: `{ type: shopify, store_url }`
  - `branches`: name, region, address, phone, email, opening hours, business lines handled
  - `routing`: rules mapping region and business line to a branch
  - `lead_fields` and request types (`info`, `quote`, `sample`)
  - `tools`: which tools are enabled
  - `model`: Claude model id and effort
  - `policies`: markdown text the agent may quote (shipping, pickup, payments, returns, FAQ)
  - `product_data`: per-SKU extras the feed lacks (e.g. m² per box)
- Loader that reads all files at startup and looks a client up by id or by channel number.
- `clients/jular.yaml` filled from the research: 4 branches (Azambuja, Maia, Camarate, Albufeira) with hours, 3 business lines, policies from loja.jular.pt FAQ and shipping pages.

## Acceptance criteria

- [ ] Invalid config fails startup with the file name and the field at fault.
- [ ] `clients/jular.yaml` validates and contains all four branches and the policy texts.
- [ ] Unit tests for lookup by id and by channel number.

## Notes

Open data from Jular: m² per box per product, lead recipients per branch, returns window, Treehouse inclusions. Leave clear `TODO` placeholders until we have them.
