/** Test helpers for the catalogue: a fake Shopify store and a synced in-memory database. */
import type { ClientConfig } from '@wa/shared';
import type { ToolContext } from '../agent/tool.js';
import { ShopifyPublicSource } from '../catalogue/source.js';
import { syncCatalogue } from '../catalogue/sync.js';
import { openDb, type Db } from '../db/index.js';
import { fixture, testClient } from './helpers.js';

export const STORE_URL = 'https://loja.example.pt';

/** A client with a Shopify catalogue, so checkout links can be built. */
export function shopClient(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return testClient({ catalogue: { type: 'shopify', store_url: STORE_URL }, ...overrides });
}

/**
 * A `fetch` that serves the two fixture pages of products.json, then an empty page. `pages`
 * replaces the page bodies; `requested` records every URL asked for.
 */
export function fakeShopifyFetch(
  pages: string[] = [fixture('shopify-products-1'), fixture('shopify-products-2')],
) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    requested.push(url.toString());
    if (url.pathname !== '/products.json') return new Response('Not found', { status: 404 });
    const page = Number(url.searchParams.get('page'));
    const body = pages[page - 1] ?? '{"products":[]}';
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, requested };
}

export function fixtureSource() {
  return new ShopifyPublicSource({ storeUrl: STORE_URL, fetch: fakeShopifyFetch().fetch });
}

export async function testDb() {
  const handle = openDb({ pgliteDir: 'memory' });
  await handle.migrate();
  return handle;
}

/** Syncs the fixture store into `db` for `client`. */
export async function seedCatalogue(db: Db, client: ClientConfig = shopClient()) {
  const result = await syncCatalogue({ db, client, source: fixtureSource() });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** A tool context with fake conversation rows: the product tools only use db, client, outbox. */
export function toolContext(db: Db, client: ClientConfig = shopClient()): ToolContext {
  const now = new Date();
  return {
    db,
    client,
    outbox: [],
    contact: {
      id: '00000000-0000-0000-0000-000000000001',
      clientId: client.id,
      waId: '351911111111',
      name: 'Rui',
      language: null,
      consent: {},
      createdAt: now,
    },
    conversation: {
      id: '00000000-0000-0000-0000-000000000002',
      clientId: client.id,
      contactId: '00000000-0000-0000-0000-000000000001',
      status: 'bot',
      lastActivityAt: now,
      branchId: null,
      assignedMemberId: null,
      teamReadAt: null,
      createdAt: now,
    },
  };
}

// Variant ids in the fixture.
export const V = {
  vinyl: '46100000000011',
  oak14: '46100000000021',
  oak20: '46100000000022',
  deck: '46100000000031',
  osmoSmall: '46100000000041',
  osmoLarge: '46100000000042',
  beam: '46100000000051',
} as const;
