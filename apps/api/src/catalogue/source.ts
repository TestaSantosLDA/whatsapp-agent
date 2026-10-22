import type { ClientConfig } from '@wa/shared';
import { z } from 'zod';

/** One sellable variant, as the catalogue sync stores it. Prices are strings with 2 decimals. */
export interface CatalogueItem {
  productId: string;
  variantId: string;
  /** Shopify handle, kept so `product_data` can be keyed by it. Not stored as a column. */
  handle: string;
  sku: string | null;
  title: string;
  /** Null for single-variant products (Shopify calls their only variant "Default Title"). */
  variantTitle: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  description: string | null;
  price: string;
  compareAtPrice: string | null;
  available: boolean;
  url: string;
  imageUrl: string | null;
}

/** Where a client's catalogue comes from. WooCommerce and CSV sources come with the next client. */
export interface CatalogueSource {
  /** Every variant in the store. Throws when the feed cannot be read in full. */
  fetchProducts(): Promise<CatalogueItem[]>;
}

// Only the fields we use; everything else in the feed is ignored.
const priceSchema = z.union([z.string(), z.number()]);
const shopifyProductSchema = z.object({
  id: z.number(),
  title: z.string(),
  handle: z.string(),
  body_html: z.string().nullish(),
  vendor: z.string().nullish(),
  product_type: z.string().nullish(),
  // products.json sends an array; older themes and the Admin API send a comma-separated string.
  tags: z.union([z.array(z.string()), z.string()]).nullish(),
  variants: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      sku: z.string().nullish(),
      price: priceSchema,
      compare_at_price: priceSchema.nullish(),
      available: z.boolean().default(true),
      featured_image: z.object({ src: z.string() }).nullish(),
    }),
  ),
  images: z
    .array(z.object({ src: z.string(), variant_ids: z.array(z.number()).default([]) }))
    .default([]),
});
const shopifyPageSchema = z.object({ products: z.array(shopifyProductSchema) });
type ShopifyProduct = z.infer<typeof shopifyProductSchema>;

/** Shopify caps a page at 250 products; this bounds a runaway loop at 50 000 products. */
const MAX_PAGES = 200;

/**
 * Reads a Shopify store's public `products.json`, which needs no admin access or app install:
 * every published product with its variants, prices and stock flag.
 */
export class ShopifyPublicSource implements CatalogueSource {
  private readonly storeUrl: string;
  private readonly fetch: typeof fetch;

  constructor(opts: { storeUrl: string; fetch?: typeof fetch }) {
    this.storeUrl = opts.storeUrl.replace(/\/+$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async fetchProducts(): Promise<CatalogueItem[]> {
    const items: CatalogueItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${this.storeUrl}/products.json?limit=250&page=${page}`;
      const res = await this.fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
      const parsed = shopifyPageSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`GET ${url}: unexpected JSON: ${z.prettifyError(parsed.error)}`);
      }
      if (parsed.data.products.length === 0) return items;
      for (const product of parsed.data.products) items.push(...this.toItems(product));
    }
    throw new Error(`${this.storeUrl}/products.json has more than ${MAX_PAGES} pages`);
  }

  private toItems(product: ShopifyProduct): CatalogueItem[] {
    const tags = Array.isArray(product.tags)
      ? product.tags
      : (product.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
    const description = htmlToText(product.body_html ?? '') || null;
    const url = `${this.storeUrl}/products/${product.handle}`;
    return product.variants.map((variant) => ({
      productId: String(product.id),
      variantId: String(variant.id),
      handle: product.handle,
      sku: variant.sku?.trim() || null,
      title: product.title.trim(),
      variantTitle: variant.title === 'Default Title' ? null : variant.title.trim(),
      productType: product.product_type?.trim() || null,
      vendor: product.vendor?.trim() || null,
      tags,
      description,
      price: toPrice(variant.price) ?? '0.00',
      compareAtPrice: toPrice(variant.compare_at_price),
      available: variant.available,
      url,
      imageUrl: absoluteUrl(
        variant.featured_image?.src ??
          product.images.find((i) => i.variant_ids.includes(variant.id))?.src ??
          product.images[0]?.src,
      ),
    }));
  }
}

/** The catalogue source a client's config describes, or undefined when it has none. */
export function sourceForClient(
  client: ClientConfig,
  opts: { fetch?: typeof fetch } = {},
): CatalogueSource | undefined {
  const catalogue = client.catalogue;
  if (!catalogue) return undefined;
  switch (catalogue.type) {
    case 'shopify':
      return new ShopifyPublicSource({ storeUrl: catalogue.store_url, fetch: opts.fetch });
  }
}

/** Some themes send protocol-relative image URLs ("//cdn.shopify.com/..."); WhatsApp needs https. */
function absoluteUrl(src: string | undefined): string | null {
  if (!src) return null;
  return src.startsWith('//') ? `https:${src}` : src;
}

/** Normalises "24.9",24.9 and "24.90" to "24.90", so unchanged prices compare equal. */
export function toPrice(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  deg: '°',
  ordm: 'º',
  ordf: 'ª',
  sup2: '²',
  sup3: '³',
  times: '×',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};
// Accented letters Portuguese text uses: &aacute; &Atilde; &ccedil; ...
for (const [suffix, accent] of [
  ['acute', '́'],
  ['grave', '̀'],
  ['circ', '̂'],
  ['tilde', '̃'],
  ['uml', '̈'],
] as const) {
  for (const letter of 'aeiouAEIOU') {
    namedEntities[letter + suffix] = (letter + accent).normalize('NFC');
  }
}
namedEntities.ntilde = 'ñ';
namedEntities.Ntilde = 'Ñ';
namedEntities.ccedil = 'ç';
namedEntities.Ccedil = 'Ç';

/** Plain text from Shopify `body_html`: tags dropped, common entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const n =
          code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
      }
      return namedEntities[code] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
