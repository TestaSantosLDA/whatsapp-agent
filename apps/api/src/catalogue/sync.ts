import type { ClientConfig } from '@wa/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { products } from '../db/schema.js';
import type { ProductRow } from './repository.js';
import { sourceForClient, type CatalogueItem, type CatalogueSource } from './source.js';

export type SyncResult =
  | {
      ok: true;
      clientId: string;
      /** Variants in the feed. */
      total: number;
      inserted: number;
      updated: number;
      unchanged: number;
      /** Rows that were available and are missing from this feed. */
      markedUnavailable: number;
    }
  | { ok: false; clientId: string; error: string };

/** The columns a sync writes; everything else (id, search vector) is the database's. */
type SyncedFields = Omit<ProductRow, 'id' | 'clientId' | 'searchVector' | 'syncedAt'>;

const CHUNK = 500;

/**
 * Brings the `products` table of one client in line with its store feed.
 *
 * - One row per variant, upserted by (client_id, variant_id). Rows whose fields did not change
 *   are not written at all, so a second identical run reports everything unchanged and
 *   `synced_at` means "last changed".
 * - Variants missing from the feed are marked unavailable, never deleted: old conversations and
 *   leads may still point at them, and they come back if the product is republished.
 * - `client.product_data` extras are merged into `extra`. Keys may be a product handle, a SKU
 *   or a variant id; for the same field the more specific key wins (variant id > SKU > handle).
 * - Any fetch or parse failure leaves the catalogue as it was. So does an empty feed while the
 *   catalogue has available rows: that is far more likely a store outage than an empty shop.
 */
export async function syncCatalogue(opts: {
  db: Db;
  client: ClientConfig;
  source: CatalogueSource;
}): Promise<SyncResult> {
  const { db, client, source } = opts;
  const clientId = client.id;
  try {
    const items = dedupe(await source.fetchProducts());
    const existing = await db.select().from(products).where(eq(products.clientId, clientId));
    if (items.length === 0 && existing.some((r) => r.available)) {
      throw new Error('the feed returned no products; keeping the current catalogue');
    }
    const byVariant = new Map(existing.map((r) => [r.variantId, r]));

    const inserts: (SyncedFields & { clientId: string })[] = [];
    const updates: { id: string; fields: SyncedFields }[] = [];
    let unchanged = 0;
    for (const item of items) {
      const fields = toFields(item, client.product_data);
      const row = byVariant.get(item.variantId);
      if (!row) inserts.push({ clientId, ...fields });
      else if (sameFields(row, fields)) unchanged++;
      else updates.push({ id: row.id, fields });
    }
    const seen = new Set(items.map((i) => i.variantId));
    const gone = existing.filter((r) => r.available && !seen.has(r.variantId)).map((r) => r.id);

    await db.transaction(async (tx) => {
      const now = new Date();
      for (let i = 0; i < inserts.length; i += CHUNK) {
        await tx
          .insert(products)
          .values(inserts.slice(i, i + CHUNK).map((r) => ({ ...r, syncedAt: now })));
      }
      for (const { id, fields } of updates) {
        await tx
          .update(products)
          .set({ ...fields, syncedAt: now })
          .where(eq(products.id, id));
      }
      for (let i = 0; i < gone.length; i += CHUNK) {
        await tx
          .update(products)
          .set({ available: false, syncedAt: now })
          .where(
            and(eq(products.clientId, clientId), inArray(products.id, gone.slice(i, i + CHUNK))),
          );
      }
    });

    const result = {
      ok: true as const,
      clientId,
      total: items.length,
      inserted: inserts.length,
      updated: updates.length,
      unchanged,
      markedUnavailable: gone.length,
    };
    console.log(
      `[catalogue] ${clientId}: ${result.total} variants, ${result.inserted} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.markedUnavailable} marked unavailable`,
    );
    return result;
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[catalogue] ${clientId}: sync failed, catalogue unchanged: ${message}`);
    return { ok: false, clientId, error: message };
  }
}

/** Syncs every client that has a catalogue, one after the other. */
export async function syncClients(opts: {
  db: Db;
  clients: ClientConfig[];
  /** Tests inject a fake source; defaults to the client's configured source. */
  sourceFor?: (client: ClientConfig) => CatalogueSource | undefined;
}): Promise<SyncResult[]> {
  const sourceFor = opts.sourceFor ?? ((client: ClientConfig) => sourceForClient(client));
  const results: SyncResult[] = [];
  for (const client of opts.clients) {
    const source = sourceFor(client);
    if (source) results.push(await syncCatalogue({ db: opts.db, client, source }));
  }
  return results;
}

function toFields(item: CatalogueItem, productData: ClientConfig['product_data']): SyncedFields {
  const extra = {
    ...productData[item.handle],
    ...(item.sku ? productData[item.sku] : undefined),
    ...productData[item.variantId],
  };
  return {
    productId: item.productId,
    variantId: item.variantId,
    sku: item.sku,
    title: item.title,
    variantTitle: item.variantTitle,
    productType: item.productType,
    vendor: item.vendor,
    tags: item.tags,
    description: item.description,
    price: item.price,
    compareAtPrice: item.compareAtPrice,
    available: item.available,
    url: item.url,
    imageUrl: item.imageUrl,
    extra,
  };
}

function sameFields(row: ProductRow, fields: SyncedFields): boolean {
  return (Object.keys(fields) as (keyof SyncedFields)[]).every((key) =>
    key === 'extra' || key === 'tags'
      ? stableJson(row[key]) === stableJson(fields[key])
      : row[key] === fields[key],
  );
}

/** JSON with sorted object keys: jsonb does not keep the key order it was given. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Node's fetch throws "fetch failed" and keeps the reason (DNS, TLS, reset) in `cause`. */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** A feed should not repeat a variant; if it does, the last copy wins. */
function dedupe(items: CatalogueItem[]): CatalogueItem[] {
  return [...new Map(items.map((i) => [i.variantId, i])).values()];
}
