import { metaSendMessageSchema } from '@wa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toMetaPayload } from '../../channels/channel.js';
import { syncCatalogue } from '../../catalogue/sync.js';
import type { DbHandle } from '../../db/index.js';
import {
  fixtureSource,
  seedCatalogue,
  shopClient,
  STORE_URL,
  testDb,
  toolContext,
  V,
} from '../../test/catalogue.js';
import { testClient } from '../../test/helpers.js';
import { ToolError, type AgentTool } from '../tool.js';
import { createCheckoutLinkTool } from './create-checkout-link.js';
import { getProductTool } from './get-product.js';
import { searchProductsTool } from './search-products.js';
import { showProductsTool } from './show-products.js';

let handle: DbHandle;
beforeAll(async () => {
  handle = await testDb();
  await seedCatalogue(handle.db);
});
afterAll(() => handle.close());

/** Runs a tool the way the agent will: input parsed by its schema first. */
async function call<T extends AgentTool>(tool: T, input: unknown, ctx = toolContext(handle.db)) {
  const result = await tool.run(tool.inputSchema.parse(input), ctx);
  return { result: result as Record<string, unknown>, ctx };
}

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe('search_products', () => {
  it('returns compact results with prices, folding the use into the query', async () => {
    const { result } = await call(searchProductsTool, { query: 'pavimento', use: 'casa de banho' });
    const results = result.results as { variant_id: string }[];
    expect(results[0]).toEqual({
      variant_id: V.vinyl,
      title: 'Pavimento Vinílico SPC Carvalho Natural',
      variant: null,
      sku: 'VIN-SPC-CN',
      type: 'Pavimento Vinílico',
      vendor: 'Jular',
      price_eur: 24.9,
      available: true,
      url: `${STORE_URL}/products/pavimento-vinilico-spc-carvalho-natural`,
      snippet: expect.stringContaining('resistente à água'),
    });
  });

  it('caps the results at 8 and flags out of stock last', async () => {
    const { result } = await call(searchProductsTool, { query: 'carvalho madeira' });
    const results = result.results as { variant_id: string; available: boolean }[];
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.at(-1)).toMatchObject({ variant_id: V.oak20, available: false });
    expect(() => searchProductsTool.inputSchema.parse({ query: 'x', limit: 9 })).toThrow();
  });

  it('says so when nothing matches', async () => {
    const { result } = await call(searchProductsTool, { query: 'telhas cerâmicas' });
    expect(result).toMatchObject({ count: 0, note: expect.any(String) });
  });
});

describe('get_product', () => {
  it('returns full details and the other variants, sending nothing by default', async () => {
    const { result, ctx } = await call(getProductTool, { sku: 'OSM-016-075' });
    expect(result).toMatchObject({
      variant_id: V.osmoSmall,
      title: 'Osmo Óleo para Decks 016 Bangkirai',
      variant: '0,75 L',
      price_eur: 32.95,
      available: true,
      special_transport: false,
      image_url: expect.stringMatching(/osmo-016\.jpg$/),
      other_variants: [
        {
          variant_id: V.osmoLarge,
          variant: '2,5 L',
          sku: 'OSM-016-25',
          price_eur: 79.95,
          available: true,
        },
      ],
      shown_to_customer: false,
    });
    expect(ctx.outbox).toEqual([]);
  });

  it('queues the photo with caption when asked', async () => {
    const { ctx } = await call(getProductTool, { variant_id: V.vinyl, show_to_customer: true });
    expect(ctx.outbox).toEqual([
      {
        type: 'image',
        url: 'https://cdn.shopify.com/s/files/1/0000/0001/products/vinilico-carvalho.jpg',
        caption: `*Pavimento Vinílico SPC Carvalho Natural*\n24,90 € (IVA incluído)\n${STORE_URL}/products/pavimento-vinilico-spc-carvalho-natural`,
      },
    ]);
  });

  it('needs a key and reports unknown products as not_found', async () => {
    expect(() => getProductTool.inputSchema.parse({})).toThrow();
    const error = await toolError(call(getProductTool, { variant_id: '999' }));
    expect(error.code).toBe('not_found');
  });
});

describe('show_products', () => {
  const valid = (to: string, ctx: ReturnType<typeof toolContext>) =>
    ctx.outbox.forEach((m) => metaSendMessageSchema.parse(toMetaPayload(to, m)));

  it('sends up to 3 products as cards, text when there is no photo', async () => {
    const { result, ctx } = await call(showProductsTool, {
      variant_ids: [V.vinyl, V.deck, V.oak20],
      language: 'en',
    });
    expect(ctx.outbox.map((m) => m.type)).toEqual(['image', 'text', 'image']);
    expect(ctx.outbox[2]).toMatchObject({ caption: expect.stringContaining('Out of stock') });
    expect(result).toEqual({
      queued: ['image', 'text', 'image'],
      shown: [V.vinyl, V.deck, V.oak20],
    });
    valid('351911111111', ctx);
  });

  it('sends more than 3 as one list within WhatsApp limits', async () => {
    const ids = [V.vinyl, V.oak14, V.oak20, V.deck, V.osmoSmall, V.osmoLarge, V.beam, 'missing'];
    const { result, ctx } = await call(showProductsTool, { variant_ids: ids });
    expect(ctx.outbox).toHaveLength(1);
    const [list] = ctx.outbox;
    if (list?.type !== 'list') throw new Error('expected a list');
    const rows = list.sections[0]!.rows;
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.title.length).toBeLessThanOrEqual(24);
      expect(row.description!.length).toBeLessThanOrEqual(72);
    }
    expect(rows[0]).toEqual({
      id: `product:${V.vinyl}`,
      title: 'Pavimento Vinílico SPC…',
      description: '24,90 €',
    });
    expect(rows[2]!.description).toBe('20 mm · 68,50 € · Esgotado');
    expect(list.button).toBe('Ver produtos');
    expect(result).toMatchObject({ queued: ['list'], not_found: ['missing'] });
    valid('351911111111', ctx);
  });

  it('rejects more than 10 ids and fails when none exist', async () => {
    expect(() =>
      showProductsTool.inputSchema.parse({ variant_ids: Array(11).fill(V.deck) }),
    ).toThrow();
    expect((await toolError(call(showProductsTool, { variant_ids: ['nope'] }))).code).toBe(
      'not_found',
    );
  });
});

describe('create_checkout_link', () => {
  it('builds a cart permalink with every item, merging repeats, and the total', async () => {
    const { result } = await call(createCheckoutLinkTool, {
      items: [
        { variant_id: V.vinyl, quantity: 10 },
        { variant_id: V.osmoSmall, quantity: 1 },
        { variant_id: V.vinyl, quantity: 2 },
      ],
    });
    expect(result).toEqual({
      url: `${STORE_URL}/cart/${V.vinyl}:12,${V.osmoSmall}:1`,
      items: [
        {
          variant_id: V.vinyl,
          title: 'Pavimento Vinílico SPC Carvalho Natural',
          variant: null,
          quantity: 12,
          unit_price_eur: 24.9,
          line_total_eur: 298.8,
        },
        {
          variant_id: V.osmoSmall,
          title: 'Osmo Óleo para Decks 016 Bangkirai',
          variant: '0,75 L',
          quantity: 1,
          unit_price_eur: 32.95,
          line_total_eur: 32.95,
        },
      ],
      total_eur: 331.75,
      note: expect.any(String),
    });
  });

  it('adds the attribution ref from config', async () => {
    const client = shopClient({
      catalogue: { type: 'shopify', store_url: `${STORE_URL}/`, checkout_ref: 'whatsapp-agent' },
    });
    const { result } = await call(
      createCheckoutLinkTool,
      { items: [{ variant_id: V.deck, quantity: 3 }] },
      toolContext(handle.db, client),
    );
    expect(result.url).toBe(`${STORE_URL}/cart/${V.deck}:3?ref=whatsapp-agent`);
  });

  it('rejects unknown and unavailable variants', async () => {
    const unknown = await toolError(
      call(createCheckoutLinkTool, { items: [{ variant_id: '1', quantity: 1 }] }),
    );
    expect(unknown.code).toBe('not_found');
    const sold = await toolError(
      call(createCheckoutLinkTool, {
        items: [
          { variant_id: V.deck, quantity: 1 },
          { variant_id: V.oak20, quantity: 2 },
        ],
      }),
    );
    expect(sold.code).toBe('unavailable');
    expect(sold.message).toContain('Soalho Madeira Maciça Carvalho — 20 mm');
  });

  it('never links a special-transport product, by tag or by product_data', async () => {
    const tagged = await toolError(
      call(createCheckoutLinkTool, {
        items: [
          { variant_id: V.deck, quantity: 1 },
          { variant_id: V.beam, quantity: 1 },
        ],
      }),
    );
    expect(tagged.code).toBe('needs_order_draft');

    const client = shopClient({
      id: 'flagged',
      product_data: { 'DCK-IPE-21': { special_transport: true } },
    });
    await syncCatalogue({ db: handle.db, client, source: fixtureSource() });
    const flagged = await toolError(
      call(
        createCheckoutLinkTool,
        { items: [{ variant_id: V.deck, quantity: 1 }] },
        toolContext(handle.db, client),
      ),
    );
    expect(flagged.code).toBe('needs_order_draft');
  });

  it('refuses when the client has no online store', async () => {
    const error = await toolError(
      call(
        createCheckoutLinkTool,
        { items: [{ variant_id: V.deck, quantity: 1 }] },
        toolContext(handle.db, testClient()),
      ),
    );
    expect(error.code).toBe('not_configured');
  });
});
