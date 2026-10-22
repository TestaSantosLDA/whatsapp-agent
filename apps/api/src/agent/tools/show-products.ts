import { z } from 'zod';
import type { OutboundMessage } from '../../channels/channel.js';
import { getVariants } from '../../catalogue/repository.js';
import { defineTool, ToolError } from '../tool.js';
import { formatEuros, labelsFor, languageSchema, productCard, truncate } from './product-view.js';

/** Up to this many products are sent as separate image cards; more go in one list message. */
const MAX_CARDS = 3;
/** WhatsApp list message limits (see metaSendMessageSchema in @wa/shared). */
const LIST = { rows: 10, rowTitle: 24, rowDescription: 72, button: 20, header: 60, body: 1024 };

/** The id a list row carries back when the customer taps it. */
export const productRowId = (variantId: string) => `product:${variantId}`;

const inputSchema = z.object({
  variant_ids: z
    .array(z.string())
    .min(1)
    .max(LIST.rows)
    .describe('1 to 10 variant ids from search_products, in the order to show them.'),
  intro: z
    .string()
    .max(LIST.body)
    .optional()
    .describe(
      'Text above the list when more than 3 products are shown, in the customer language. Ignored for 1-3 products.',
    ),
  button_label: z
    .string()
    .max(LIST.button)
    .optional()
    .describe('Label of the list button (max 20 characters). Default "Ver produtos".'),
  language: languageSchema,
});

export const showProductsTool = defineTool({
  name: 'show_products',
  description: `Show products to the customer in WhatsApp, after your text reply: 1 to 3 products are sent as photo cards (name, price with VAT, stock and link); 4 to 10 are sent as one list message the customer can tap to pick one (the pick comes back as the row title followed by "[tapped: product:<variant_id>]").

Use it when recommending specific products from search_products, typically 2 or 3. Your text reply should still say briefly why each fits; do not repeat every price and link that the cards already show. Returns what was queued and any variant ids that were not found.`,
  inputSchema,
  async run(input, ctx) {
    const rows = await getVariants(ctx.db, ctx.client.id, input.variant_ids);
    if (rows.length === 0) {
      throw new ToolError(
        'not_found',
        `None of these variants exist: ${input.variant_ids.join(', ')}.`,
      );
    }
    const found = new Set(rows.map((r) => r.variantId));
    const missing = input.variant_ids.filter((id) => !found.has(id));
    const lang = labelsFor(ctx.client, input.language);

    let messages: OutboundMessage[];
    if (rows.length <= MAX_CARDS) {
      messages = rows.map((row) => productCard(row, lang));
    } else {
      messages = [
        {
          type: 'list',
          body: truncate(input.intro ?? lang.intro, LIST.body),
          button: truncate(input.button_label ?? lang.button, LIST.button),
          sections: [
            {
              rows: rows.slice(0, LIST.rows).map((row) => {
                const price = formatEuros(Number(row.price));
                const details = [row.variantTitle, price, row.available ? null : lang.outOfStock]
                  .filter(Boolean)
                  .join(' · ');
                return {
                  id: productRowId(row.variantId),
                  title: truncate(row.title, LIST.rowTitle),
                  description: truncate(details, LIST.rowDescription),
                };
              }),
            },
          ],
        },
      ];
    }
    ctx.outbox.push(...messages);
    return {
      queued: messages.map((m) => m.type),
      shown: rows.map((r) => r.variantId),
      ...(missing.length && { not_found: missing }),
    };
  },
});
