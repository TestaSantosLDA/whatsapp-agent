import { z } from 'zod';
import type { OutboundMessage } from '../../channels/channel.js';
import { getVariants, type ProductRow } from '../../catalogue/repository.js';
import { defineTool, ToolError } from '../tool.js';
import { formatEuros, labelsFor, languageSchema, productCard, truncate } from './product-view.js';

/** Up to this many products are sent as separate image cards; more go in one list message. */
const MAX_CARDS = 3;
/** WhatsApp list message limits (see metaSendMessageSchema in @wa/shared). */
const LIST = { rows: 10, rowTitle: 24, rowDescription: 72, button: 20, header: 60, body: 1024 };

/** The id a list row carries back when the customer taps it. */
export const productRowId = (variantId: string) => `product:${variantId}`;

/**
 * Row titles a customer can tell apart. Catalogue names often share a long start ("Pavimento
 * Flutuante de Madeira Multicamadas - Kährs Carvalho Amber"), which a 24-character title cuts to
 * the same text on every row, so the words all names share are dropped first.
 */
export function distinctNames(titles: string[]): string[] {
  const words = titles.map((t) => t.split(/\s+/));
  let common = 0;
  if (titles.length > 1) {
    while (words.every((w) => common < w.length - 1 && w[common] === words[0]![common])) common++;
  }
  return words.map((w, i) => {
    const rest = w
      .slice(common)
      .join(' ')
      .replace(/^[-–—·:|,\s]+/, '');
    return rest || titles[i]!;
  });
}

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
  row_titles: z
    .array(z.string().min(1).max(LIST.rowTitle))
    .max(LIST.rows)
    .optional()
    .describe(
      'For 4 or more products: a short title per product (max 24 characters), in the same order as variant_ids, that tells it apart from the others (e.g. "Kährs Carvalho Amber", not the shared "Pavimento Flutuante…"). Default: the product names without the words they all share.',
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
              rows: listRows(rows.slice(0, LIST.rows), input, lang.outOfStock),
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

function listRows(rows: ProductRow[], input: z.infer<typeof inputSchema>, outOfStock: string) {
  const given = new Map(input.variant_ids.map((id, i) => [id, input.row_titles?.[i]]));
  const names = distinctNames(rows.map((r) => r.title));
  return rows.map((row, i) => {
    const name = names[i]!;
    const title = given.get(row.variantId) ?? truncate(name, LIST.rowTitle);
    const details = [
      row.variantTitle,
      formatEuros(Number(row.price)),
      row.available ? null : outOfStock,
      // The full name when the title does not show it.
      title === name ? null : name,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      id: productRowId(row.variantId),
      title,
      description: truncate(details, LIST.rowDescription),
    };
  });
}
