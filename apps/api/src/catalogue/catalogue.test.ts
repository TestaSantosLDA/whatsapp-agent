import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../db/index.js';
import { products } from '../db/schema.js';
import {
  fakeShopifyFetch,
  fixtureSource,
  seedCatalogue,
  shopClient,
  STORE_URL,
  testDb,
  V,
} from '../test/catalogue.js';
import { getProduct, getVariants, isSpecialTransport, searchProducts } from './repository.js';
import {
  htmlToText,
  ShopifyPublicSource,
  type CatalogueItem,
  type CatalogueSource,
} from './source.js';
import { syncCatalogue } from './sync.js';

let handle: DbHandle;
beforeAll(async () => {
  handle = await testDb();
});
afterAll(() => handle.close());
beforeEach(async () => {
  await handle.db.delete(products);
});

/** A source that returns fixed items, so a test can change the feed between syncs. */
function staticSource(items: CatalogueItem[]): CatalogueSource {
  return { fetchProducts: async () => structuredClone(items) };
}

describe('ShopifyPublicSource', () => {
  it('reads every page until an empty one, one item per variant', async () => {
    const { fetch, requested } = fakeShopifyFetch();
    const items = await new ShopifyPublicSource({
      storeUrl: `${STORE_URL}/`,
      fetch,
    }).fetchProducts();
    expect(requested).toEqual(
      [1, 2, 3].map((p) => `${STORE_URL}/products.json?limit=250&page=${p}`),
    );
    expect(items.map((i) => i.variantId)).toEqual(Object.values(V));
  });

  it('maps the fields we store', async () => {
    const items = await fixtureSource().fetchProducts();
    const vinyl = items.find((i) => i.variantId === V.vinyl)!;
    expect(vinyl).toEqual({
      productId: '8101000000001',
      variantId: V.vinyl,
      handle: 'pavimento-vinilico-spc-carvalho-natural',
      sku: 'VIN-SPC-CN',
      title: 'Pavimento Vinílico SPC Carvalho Natural',
      variantTitle: null,
      productType: 'Pavimento Vinílico',
      vendor: 'Jular',
      tags: ['SPC', 'vinílico', 'resistente à água'],
      description:
        'Pavimento vinílico SPC 100% resistente à água, ideal para cozinhas e casas de banho. Espessura: 5 mm Caixa de 2,2 m²',
      price: '24.90',
      compareAtPrice: '29.90',
      available: true,
      url: `${STORE_URL}/products/pavimento-vinilico-spc-carvalho-natural`,
      imageUrl: 'https://cdn.shopify.com/s/files/1/0000/0001/products/vinilico-carvalho.jpg',
    });
    const oak20 = items.find((i) => i.variantId === V.oak20)!;
    expect(oak20).toMatchObject({ variantTitle: '20 mm', price: '68.50', available: false });
    // The variant's own image wins, and protocol-relative URLs become https.
    expect(oak20.imageUrl).toBe(
      'https://cdn.shopify.com/s/files/1/0000/0001/products/soalho-20.jpg',
    );
    expect(items.find((i) => i.variantId === V.oak14)!.imageUrl).toMatch(/soalho-14\.jpg$/);
    const deck = items.find((i) => i.variantId === V.deck)!;
    expect(deck).toMatchObject({
      tags: ['deck', 'exterior', 'ipê'],
      compareAtPrice: null,
      imageUrl: null,
    });
  });

  it('fails on an error status or a body that is not a products feed', async () => {
    const down = new ShopifyPublicSource({
      storeUrl: STORE_URL,
      fetch: (async () => new Response('busy', { status: 503 })) as typeof fetch,
    });
    await expect(down.fetchProducts()).rejects.toThrow(/503/);
    const { fetch } = fakeShopifyFetch(['{"items":[]}']);
    await expect(
      new ShopifyPublicSource({ storeUrl: STORE_URL, fetch }).fetchProducts(),
    ).rejects.toThrow(/unexpected JSON/);
  });
});

describe('htmlToText', () => {
  it('drops tags and scripts, decodes entities and collapses whitespace', () => {
    expect(
      htmlToText(
        '<p>Ol&aacute;&nbsp;&amp; <b>bem-vindo</b></p>\n<script>x()</script><p>&#8364;5 &#x2013; 2&times;3 &bogus;</p>',
      ),
    ).toBe('Olá & bem-vindo €5 – 2×3 &bogus;');
  });
});

describe('syncCatalogue', () => {
  it('stores every variant, and a second identical run changes nothing', async () => {
    const { db } = handle;
    const first = await seedCatalogue(db);
    expect(first).toMatchObject({
      ok: true,
      total: 7,
      inserted: 7,
      updated: 0,
      unchanged: 0,
      markedUnavailable: 0,
    });
    const before = await db.select().from(products);

    const second = await seedCatalogue(db);
    expect(second).toMatchObject({
      ok: true,
      total: 7,
      inserted: 0,
      updated: 0,
      unchanged: 7,
      markedUnavailable: 0,
    });
    const after = await db.select().from(products);
    expect(after.map((r) => r.syncedAt.getTime()).sort()).toEqual(
      before.map((r) => r.syncedAt.getTime()).sort(),
    );
  });

  it('reflects a price change after the next sync', async () => {
    const { db } = handle;
    const items = await fixtureSource().fetchProducts();
    const client = shopClient();
    await syncCatalogue({ db, client, source: staticSource(items) });
    items.find((i) => i.variantId === V.deck)!.price = '39.90';
    const result = await syncCatalogue({ db, client, source: staticSource(items) });
    expect(result).toMatchObject({ ok: true, updated: 1, unchanged: 6 });
    expect((await getProduct(db, client.id, { variantId: V.deck }))?.price).toBe('39.90');
  });

  it('marks variants missing from the feed unavailable instead of deleting them', async () => {
    const { db } = handle;
    const items = await fixtureSource().fetchProducts();
    const client = shopClient();
    await syncCatalogue({ db, client, source: staticSource(items) });
    const result = await syncCatalogue({
      db,
      client,
      source: staticSource(items.filter((i) => i.variantId !== V.deck)),
    });
    expect(result).toMatchObject({ ok: true, markedUnavailable: 1, unchanged: 6 });
    expect(await db.select().from(products)).toHaveLength(7);
    expect((await getProduct(db, client.id, { variantId: V.deck }))?.available).toBe(false);
    // It comes back when the product is republished.
    const back = await syncCatalogue({ db, client, source: staticSource(items) });
    expect(back).toMatchObject({ updated: 1, markedUnavailable: 0 });
  });

  it('keeps the catalogue and logs when the fetch fails or the feed is empty', async () => {
    const { db } = handle;
    const client = shopClient();
    await seedCatalogue(db, client);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: CatalogueSource = {
      fetchProducts: async () => {
        throw new Error('ECONNRESET');
      },
    };
    expect(await syncCatalogue({ db, client, source: failing })).toEqual({
      ok: false,
      clientId: client.id,
      error: 'ECONNRESET',
    });
    expect(await syncCatalogue({ db, client, source: staticSource([]) })).toMatchObject({
      ok: false,
    });
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
    const rows = await db.select().from(products).where(eq(products.available, true));
    expect(rows).toHaveLength(6);
  });

  it('merges product_data by handle, SKU and variant id, the most specific winning', async () => {
    const { db } = handle;
    const client = shopClient({
      product_data: {
        'pavimento-vinilico-spc-carvalho-natural': { m2_per_box: 2.0, note: 'by handle' },
        'VIN-SPC-CN': { m2_per_box: 2.2 },
        [V.oak14]: { special_transport: true },
      },
    });
    await seedCatalogue(db, client);
    expect((await getProduct(db, client.id, { variantId: V.vinyl }))?.extra).toEqual({
      m2_per_box: 2.2,
      note: 'by handle',
    });
    const oak = (await getProduct(db, client.id, { variantId: V.oak14 }))!;
    expect(isSpecialTransport(oak)).toBe(true);
    expect(isSpecialTransport((await getProduct(db, client.id, { variantId: V.beam }))!)).toBe(
      true,
    );
    expect(isSpecialTransport((await getProduct(db, client.id, { variantId: V.deck }))!)).toBe(
      false,
    );
    // Extras count as data: the second run is still a no-op.
    expect(await seedCatalogue(db, client)).toMatchObject({ unchanged: 7 });
  });

  it('keeps clients apart', async () => {
    const { db } = handle;
    await seedCatalogue(db, shopClient({ id: 'other' }));
    const result = await seedCatalogue(db);
    expect(result).toMatchObject({ inserted: 7, markedUnavailable: 0 });
    expect(await db.select().from(products)).toHaveLength(14);
  });
});

describe('searchProducts', () => {
  const search = (query: string, extra: Partial<Parameters<typeof searchProducts>[2]> = {}) =>
    searchProducts(handle.db, 'acme', { query, limit: 8, ...extra }).then((hits) =>
      hits.map((h) => h.product.variantId),
    );
  beforeEach(() => seedCatalogue(handle.db));

  it('finds water-resistant vinyl for a bathroom, not solid wood', async () => {
    expect(await search('casa de banho')).toEqual([V.vinyl]);
    const sentence = await search('Preciso de pavimento para uma casa de banho');
    expect(sentence[0]).toBe(V.vinyl);
  });

  it('finds Osmo oil by brand, also with English words mixed in', async () => {
    expect(await search('Osmo')).toEqual([V.osmoSmall, V.osmoLarge]);
    expect((await search('Osmo oil')).slice(0, 2)).toEqual([V.osmoSmall, V.osmoLarge]);
    expect(await search('óleo', { vendor: 'osmo' })).toEqual([V.osmoSmall, V.osmoLarge]);
  });

  it('matches a SKU exactly first', async () => {
    expect((await search('DCK-IPE-21'))[0]).toBe(V.deck);
    expect((await search('OSM-016-25'))[0]).toBe(V.osmoLarge);
  });

  it('lists out-of-stock variants last, or not at all with inStockOnly', async () => {
    expect(await search('soalho carvalho')).toEqual([V.oak14, V.oak20]);
    expect(await search('soalho carvalho', { inStockOnly: true })).toEqual([V.oak14]);
  });

  it('applies type and price filters', async () => {
    expect(await search('exterior', { productType: 'deck' })).toEqual([V.deck]);
    expect(await search('osmo', { maxPrice: 50 })).toEqual([V.osmoSmall]);
  });

  it('falls back to the title for part of a word or a query without words', async () => {
    expect(await search('Bangk')).toEqual([V.osmoSmall, V.osmoLarge]);
    expect(await search('GL24h 12')).toEqual([V.beam]);
    expect(await search('—')).toEqual([]);
  });

  it('never returns another client', async () => {
    expect(await searchProducts(handle.db, 'other', { query: 'osmo', limit: 8 })).toEqual([]);
  });
});

describe('getVariants and getProduct', () => {
  beforeEach(() => seedCatalogue(handle.db));

  it('returns rows in the order asked, skipping unknown ids', async () => {
    const rows = await getVariants(handle.db, 'acme', [V.deck, 'nope', V.vinyl]);
    expect(rows.map((r) => r.variantId)).toEqual([V.deck, V.vinyl]);
  });

  it('finds by SKU (any case) and by product id (cheapest available variant)', async () => {
    expect((await getProduct(handle.db, 'acme', { sku: 'dck-ipe-21' }))?.variantId).toBe(V.deck);
    expect((await getProduct(handle.db, 'acme', { productId: '8101000000004' }))?.variantId).toBe(
      V.osmoSmall,
    );
  });
});
