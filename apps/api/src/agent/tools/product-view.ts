/** Shared shapes and wording for the product tools: what Claude reads and what customers see. */
import type { ClientConfig } from '@wa/shared';
import { z } from 'zod';
import type { OutboundMessage } from '../../channels/channel.js';
import { isSpecialTransport, type ProductRow } from '../../catalogue/repository.js';

export const languageSchema = z
  .enum(['pt', 'en'])
  .optional()
  .describe(
    "Language of the customer-facing text (captions, labels): 'pt' or 'en'. Defaults to the store's language.",
  );

const labels = {
  pt: {
    outOfStock: 'Esgotado',
    vat: 'IVA incluído',
    button: 'Ver produtos',
    intro: 'Estas são algumas opções:',
  },
  en: {
    outOfStock: 'Out of stock',
    vat: 'VAT included',
    button: 'See products',
    intro: 'Here are some options:',
  },
} as const;
export type Lang = keyof typeof labels;

export function labelsFor(client: ClientConfig, lang: Lang | undefined) {
  return labels[lang ?? (client.default_language.startsWith('en') ? 'en' : 'pt')];
}

/** The stored price (numeric string, VAT included) as a number of euros. */
export function euros(price: string | null): number | null {
  return price === null ? null : Number(price);
}

const eurosFormat = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

/** "24,90 €", the way Portuguese customers read prices (Intl's no-break space made plain). */
export function formatEuros(value: number): string {
  return eurosFormat.format(value).replace(/\s/g, ' ');
}

/** Cuts text to `max` characters, ending with "…" when it was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function displayTitle(row: ProductRow): string {
  return row.variantTitle ? `${row.title} — ${row.variantTitle}` : row.title;
}

/** The compact view search results use: enough to choose, not to describe. */
export function compactView(row: ProductRow) {
  return {
    variant_id: row.variantId,
    title: row.title,
    variant: row.variantTitle,
    sku: row.sku,
    type: row.productType,
    vendor: row.vendor,
    price_eur: euros(row.price),
    available: row.available,
    url: row.url,
    snippet: row.description ? truncate(row.description, 160) : null,
  };
}

/** Everything we know about one variant. */
export function fullView(row: ProductRow) {
  return {
    variant_id: row.variantId,
    product_id: row.productId,
    sku: row.sku,
    title: row.title,
    variant: row.variantTitle,
    type: row.productType,
    vendor: row.vendor,
    tags: row.tags,
    description: row.description,
    price_eur: euros(row.price),
    compare_at_price_eur: euros(row.compareAtPrice),
    price_note:
      'VAT (IVA 23%) included. Unit as sold by the store (per item, box or m², see title).',
    available: row.available,
    special_transport: isSpecialTransport(row),
    url: row.url,
    image_url: row.imageUrl,
    extra: row.extra,
  };
}

/** Caption for a product image: name, price, stock, link. Well under WhatsApp's 1024 limit. */
export function productCaption(row: ProductRow, lang: ReturnType<typeof labelsFor>): string {
  const price = `${formatEuros(Number(row.price))} (${lang.vat})`;
  const lines = [
    `*${truncate(displayTitle(row), 200)}*`,
    row.available ? price : `${price} · ${lang.outOfStock}`,
    row.url,
  ];
  return lines.join('\n');
}

/** An image card when the product has a picture, otherwise the same text as a plain message. */
export function productCard(row: ProductRow, lang: ReturnType<typeof labelsFor>): OutboundMessage {
  const caption = productCaption(row, lang);
  return row.imageUrl
    ? { type: 'image', url: row.imageUrl, caption }
    : { type: 'text', text: caption };
}
