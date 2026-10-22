import { z } from 'zod';
import { searchProducts } from '../../catalogue/repository.js';
import { defineTool } from '../tool.js';
import { compactView } from './product-view.js';

const MAX_RESULTS = 8;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Search words, ideally in Portuguese as the catalogue is: product kind, material, wood, colour, brand or SKU. E.g. "pavimento vinílico carvalho", "óleo osmo deck", "DCK-IPE-21".',
    ),
  use: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Where or how the product will be used, in Portuguese, e.g. "casa de banho", "exterior", "cozinha", "resistente à água". Added to the search words.',
    ),
  product_type: z
    .string()
    .max(100)
    .optional()
    .describe('Only products whose type contains this text, e.g. "Deck", "Vinílico", "Óleo".'),
  vendor: z.string().max(100).optional().describe('Only this brand, e.g. "Osmo".'),
  max_price: z
    .number()
    .positive()
    .optional()
    .describe('Maximum unit price in euros, VAT included.'),
  in_stock_only: z
    .boolean()
    .optional()
    .describe('Leave out products that are out of stock. Default false (they are listed last).'),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`At most ${MAX_RESULTS}.`),
});

export const searchProductsTool = defineTool({
  name: 'search_products',
  description: `Search the store's live catalogue (synced from the online shop). Use it whenever the customer asks for a kind of product, a brand, a SKU, or a recommendation, before naming any product or price.

Returns up to ${MAX_RESULTS} variants, best match first: variant_id, title, variant, sku, type, vendor, price_eur (unit price in euros, VAT 23% included), available, url, and a short description snippet. Products that are out of stock come last and have available=false: say so, and do not recommend them first.

Words that match every term rank first; if nothing matches every term, products matching any term are returned. Short, specific queries work best; try again with other words (synonyms, the product type) when results look off. The catalogue only holds what the online store sells: if nothing fits, say so rather than guessing. Use get_product for full details of one result and show_products to show results to the customer.`,
  inputSchema,
  async run(input, ctx) {
    const query = [input.query, input.use].filter(Boolean).join(' ');
    const hits = await searchProducts(ctx.db, ctx.client.id, {
      query,
      productType: input.product_type,
      vendor: input.vendor,
      maxPrice: input.max_price,
      inStockOnly: input.in_stock_only,
      limit: input.limit ?? MAX_RESULTS,
    });
    return {
      count: hits.length,
      results: hits.map((h) => compactView(h.product)),
      ...(hits.length === 0 && {
        note: 'No products matched. Try fewer or different words, or drop the filters.',
      }),
    };
  },
});
