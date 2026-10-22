import { z } from 'zod';
import { getVariants, isSpecialTransport } from '../../catalogue/repository.js';
import { defineTool, ToolError } from '../tool.js';
import { displayTitle } from './product-view.js';

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        variant_id: z.string().describe('Variant id from search_products or get_product.'),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(9999)
          .describe('Units as the store sells them (item, box or m², see the product title).'),
      }),
    )
    .min(1)
    .max(30),
});

export const createCheckoutLinkTool = defineTool({
  name: 'create_checkout_link',
  description: `Build a link to the online store's checkout with these items and quantities already in the cart. The customer pays on the store; shipping is calculated there.

Only call it after you have shown the customer a summary (items, quantities, total) and they confirmed they want to buy. Every variant must be in the catalogue and available.

Errors: not_found (unknown variant id: search again), unavailable (out of stock: offer an alternative), needs_order_draft (a product needs special transport, so the store quotes transport case by case after the order: do not send a link, offer to pass the order to the team instead). Delivery to Madeira, the Azores or abroad also has transport quoted separately: if the customer mentions it, do not use this tool either.

Returns url, the items with unit and line prices in euros (VAT included) and the total excluding shipping.`,
  inputSchema,
  async run(input, ctx) {
    const catalogue = ctx.client.catalogue;
    if (catalogue?.type !== 'shopify') {
      throw new ToolError('not_configured', 'This store has no online checkout.');
    }

    // The same variant twice becomes one line with the quantities added up.
    const quantities = new Map<string, number>();
    for (const item of input.items) {
      quantities.set(item.variant_id, (quantities.get(item.variant_id) ?? 0) + item.quantity);
    }
    const ids = [...quantities.keys()];
    const rows = await getVariants(ctx.db, ctx.client.id, ids);
    const byId = new Map(rows.map((r) => [r.variantId, r]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new ToolError('not_found', `Unknown variant id(s): ${missing.join(', ')}.`);
    }
    const unavailable = rows.filter((r) => !r.available);
    if (unavailable.length) {
      throw new ToolError(
        'unavailable',
        `Out of stock: ${unavailable.map((r) => `${displayTitle(r)} (${r.variantId})`).join(', ')}.`,
      );
    }
    const special = rows.filter(isSpecialTransport);
    if (special.length) {
      throw new ToolError(
        'needs_order_draft',
        `Special transport, quoted after the order, so no checkout link: ${special.map(displayTitle).join(', ')}. The whole order is handled as special; pass it to the team as an order draft.`,
      );
    }

    // Cents, so the total adds up exactly.
    let totalCents = 0;
    const items = rows.map((row) => {
      const quantity = quantities.get(row.variantId)!;
      const unitCents = Math.round(Number(row.price) * 100);
      totalCents += unitCents * quantity;
      return {
        variant_id: row.variantId,
        title: row.title,
        variant: row.variantTitle,
        quantity,
        unit_price_eur: unitCents / 100,
        line_total_eur: (unitCents * quantity) / 100,
      };
    });

    const store = catalogue.store_url.replace(/\/+$/, '');
    const cart = items.map((i) => `${i.variant_id}:${i.quantity}`).join(',');
    const ref = catalogue.checkout_ref ? `?ref=${encodeURIComponent(catalogue.checkout_ref)}` : '';
    return {
      url: `${store}/cart/${cart}${ref}`,
      items,
      total_eur: totalCents / 100,
      note: 'Prices include VAT. Shipping is calculated at checkout.',
    };
  },
});
