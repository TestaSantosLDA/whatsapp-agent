import { z } from 'zod';
import { getProduct, getProductVariants, type ProductKey } from '../../catalogue/repository.js';
import { defineTool, ToolError } from '../tool.js';
import { euros, fullView, labelsFor, languageSchema, productCard } from './product-view.js';

const inputSchema = z
  .object({
    variant_id: z.string().optional().describe('Variant id from search_products (preferred).'),
    product_id: z.string().optional(),
    sku: z.string().optional(),
    show_to_customer: z
      .boolean()
      .optional()
      .describe(
        'Also send the customer the product photo with name, price and link, after your reply. Default false.',
      ),
    language: languageSchema,
  })
  .refine((v) => v.variant_id || v.product_id || v.sku, {
    message: 'Give variant_id, product_id or sku',
  });

export const getProductTool = defineTool({
  name: 'get_product',
  description: `Full details of one product variant from the live catalogue: title, variant, type, brand, tags, full description, unit price in euros (VAT 23% included), compare-at price, availability, whether it needs special transport, store link, image and extra data from the store (for example m² per box). Also lists the product's other variants (sizes, thicknesses, colours) with their prices and stock.

Use it before answering detailed questions about a product (dimensions, use, maintenance) or quoting its price. Look it up by variant_id from search_products; product_id or sku also work. Set show_to_customer=true to also send the customer the photo with price and link.`,
  inputSchema,
  async run(input, ctx) {
    const key: ProductKey = input.variant_id
      ? { variantId: input.variant_id }
      : input.sku
        ? { sku: input.sku }
        : { productId: input.product_id! };
    const row = await getProduct(ctx.db, ctx.client.id, key);
    if (!row) throw new ToolError('not_found', `No product found for ${JSON.stringify(key)}.`);

    const variants = await getProductVariants(ctx.db, ctx.client.id, row.productId);
    let shown = false;
    if (input.show_to_customer) {
      ctx.outbox.push(productCard(row, labelsFor(ctx.client, input.language)));
      shown = true;
    }
    return {
      ...fullView(row),
      other_variants: variants
        .filter((v) => v.variantId !== row.variantId)
        .map((v) => ({
          variant_id: v.variantId,
          variant: v.variantTitle,
          sku: v.sku,
          price_eur: euros(v.price),
          available: v.available,
        })),
      shown_to_customer: shown,
    };
  },
});
