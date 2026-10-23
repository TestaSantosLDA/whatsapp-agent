/**
 * Product data approved in the dashboard (WA-026), on top of `product_data` from the client YAML.
 *
 * Both are maps keyed by product handle, SKU or variant id. A variant's `extra` is
 * YAML (handle < SKU < variant id), then the database (handle < SKU < variant id): an approved
 * value always wins over the file. The catalogue sync applies both; an approval rewrites the
 * affected rows at once, so the calculator sees a new m² per box from the next turn without a sync.
 */
import type { ClientConfig } from '@wa/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { productDataOverrides, products } from '../db/schema.js';

export type ProductData = ClientConfig['product_data'];

/** Approved values for one client, shaped like `product_data`. */
export async function loadProductOverrides(db: Db, clientId: string): Promise<ProductData> {
  const rows = await db
    .select({
      key: productDataOverrides.productKey,
      field: productDataOverrides.field,
      value: productDataOverrides.value,
    })
    .from(productDataOverrides)
    .where(eq(productDataOverrides.clientId, clientId));
  const data: ProductData = {};
  for (const row of rows) (data[row.key] ??= {})[row.field] = row.value;
  return data;
}

export interface ProductKeys {
  handle: string | null;
  sku: string | null;
  variantId: string;
}

/** The `extra` object for one variant. */
export function productExtra(
  item: ProductKeys,
  yaml: ProductData,
  overrides: ProductData = {},
): Record<string, unknown> {
  const pick = (data: ProductData) => ({
    ...(item.handle ? data[item.handle] : undefined),
    ...(item.sku ? data[item.sku] : undefined),
    ...data[item.variantId],
  });
  return { ...pick(yaml), ...pick(overrides) };
}

/**
 * The product handle from a stored product URL (`<store>/products/<handle>`); the handle is not
 * a column of its own.
 */
export function handleFromUrl(url: string): string | null {
  const m = /\/products\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Recomputes `extra` for every catalogue row of the client from the YAML and the approved data,
 * writing only the rows that changed. Returns how many changed.
 */
export async function applyProductOverrides(db: Db, client: ClientConfig): Promise<number> {
  const overrides = await loadProductOverrides(db, client.id);
  const rows = await db
    .select({
      id: products.id,
      url: products.url,
      sku: products.sku,
      variantId: products.variantId,
      extra: products.extra,
    })
    .from(products)
    .where(eq(products.clientId, client.id));
  let changed = 0;
  for (const row of rows) {
    const extra = productExtra(
      { handle: handleFromUrl(row.url), sku: row.sku, variantId: row.variantId },
      client.product_data,
      overrides,
    );
    if (stableJson(extra) === stableJson(row.extra)) continue;
    await db.update(products).set({ extra }).where(eq(products.id, row.id));
    changed++;
  }
  return changed;
}

/** JSON with sorted object keys: jsonb does not keep the key order it was given. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
