import { and, asc, desc, eq, ilike, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { products } from '../db/schema.js';

export type ProductRow = typeof products.$inferSelect;

export interface SearchFilters {
  query: string;
  /** Substring of the product type, case-insensitive ("vinílico", "Deck"). */
  productType?: string;
  /** Substring of the brand, case-insensitive. */
  vendor?: string;
  /** Euros, VAT included, like the stored price. */
  maxPrice?: number;
  inStockOnly?: boolean;
  limit: number;
}

export interface SearchHit {
  product: ProductRow;
  rank: number;
}

/**
 * Full-text search over the synced catalogue of one client.
 *
 * The query runs through both the 'portuguese' config (stemming, stop words) and 'simple'
 * (SKUs and brand names as written), ORed together. Rows that match every term come first; if
 * none do, rows that match any term are returned instead, so a long customer sentence ("preciso
 * de pavimento para uma casa de banho") still finds something. Available rows always sort
 * before unavailable ones, then an exact SKU match, then ts_rank. When the query has no
 * searchable words at all (only stop words or punctuation) it falls back to ILIKE on the title.
 */
export async function searchProducts(
  db: Db,
  clientId: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const query = filters.query.trim();
  const base: SQL[] = [eq(products.clientId, clientId)];
  if (filters.productType)
    base.push(ilike(products.productType, `%${escapeLike(filters.productType)}%`));
  if (filters.vendor) base.push(ilike(products.vendor, `%${escapeLike(filters.vendor)}%`));
  if (filters.maxPrice !== undefined) base.push(lte(products.price, filters.maxPrice.toFixed(2)));
  if (filters.inStockOnly) base.push(eq(products.available, true));

  const allTerms = sql`(websearch_to_tsquery('portuguese', ${query}) || websearch_to_tsquery('simple', ${query}))`;
  const anyTerm = sql`(${orQuery('portuguese', query)} || ${orQuery('simple', query)})`;
  const run = (match: SQL | undefined, rankQuery: SQL | undefined) => {
    const rank = rankQuery
      ? sql<number>`ts_rank(${products.searchVector}, ${rankQuery})`.mapWith(Number)
      : // A bare 0 in ORDER BY would mean "column 0".
        sql<number>`0::real`.mapWith(Number);
    return db
      .select({ product: products, rank })
      .from(products)
      .where(and(...base, match))
      .orderBy(
        desc(products.available),
        desc(sql`lower(coalesce(${products.sku}, '')) = lower(${query})`),
        desc(rank),
        asc(products.price),
        asc(products.title),
      )
      .limit(filters.limit);
  };

  if (!query) return run(undefined, undefined);

  const byTitle = () => run(ilike(products.title, `%${escapeLike(query)}%`), undefined);
  const [check] = rowsOf<{ searchable: boolean }>(
    await db.execute(sql`select numnode(${allTerms}) > 0 as searchable`),
  );
  if (!check?.searchable) return byTitle();

  const strict = await run(sql`${products.searchVector} @@ ${allTerms}`, anyTerm);
  if (strict.length > 0) return strict;
  const loose = await run(sql`${products.searchVector} @@ ${anyTerm}`, anyTerm);
  // Part of a word ("Bangk") matches no token; the title may still contain it.
  return loose.length > 0 ? loose : byTitle();
}

export type ProductKey = { variantId: string } | { productId: string } | { sku: string };

/**
 * One variant by variant id, SKU or product id. For a product id with several variants, the
 * cheapest available one is returned; use getProductVariants for the rest.
 */
export async function getProduct(
  db: Db,
  clientId: string,
  key: ProductKey,
): Promise<ProductRow | undefined> {
  const match =
    'variantId' in key
      ? eq(products.variantId, key.variantId)
      : 'sku' in key
        ? sql`lower(${products.sku}) = lower(${key.sku})`
        : eq(products.productId, key.productId);
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.clientId, clientId), match))
    .orderBy(desc(products.available), asc(products.price))
    .limit(1);
  return row;
}

/** Every variant of a product, available first, then by price. */
export function getProductVariants(
  db: Db,
  clientId: string,
  productId: string,
): Promise<ProductRow[]> {
  return db
    .select()
    .from(products)
    .where(and(eq(products.clientId, clientId), eq(products.productId, productId)))
    .orderBy(desc(products.available), asc(products.price));
}

/** The rows for these variant ids, in the order the ids were given; unknown ids are skipped. */
export async function getVariants(
  db: Db,
  clientId: string,
  variantIds: string[],
): Promise<ProductRow[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.clientId, clientId), inArray(products.variantId, variantIds)));
  const byId = new Map(rows.map((r) => [r.variantId, r]));
  return [...new Set(variantIds)].flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** Tags that mark a product as special transport in Shopify, compared without case or accents. */
const SPECIAL_TRANSPORT_TAGS = new Set(['transporte especial', 'special transport']);

/**
 * Special-transport products (long beams, big panels, modular houses) are quoted for transport
 * case by case after the order (Jular's `envio` policy), so they never get a checkout link.
 * A product is special when its Shopify tags include "Transporte Especial" (or "special
 * transport", "transporte-especial"), or when `product_data` sets `special_transport: true`.
 */
export function isSpecialTransport(row: Pick<ProductRow, 'tags' | 'extra'>): boolean {
  if ((row.extra as Record<string, unknown> | null)?.special_transport === true) return true;
  return row.tags.some((tag) => SPECIAL_TRANSPORT_TAGS.has(normaliseTag(tag)));
}

function normaliseTag(tag: string): string {
  return tag
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The same query with every AND turned into OR, so it matches rows with any of the words.
 * Negations are dropped: "a | !b" would match nearly every row.
 */
function orQuery(config: 'portuguese' | 'simple', query: string): SQL {
  return sql`replace(replace(websearch_to_tsquery(${config}, ${query})::text, '!', ''), ' & ', ' | ')::tsquery`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** postgres-js returns the rows array; PGlite returns `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}
