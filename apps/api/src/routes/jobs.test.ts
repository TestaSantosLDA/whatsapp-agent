import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientRegistry } from '../clients/registry.js';
import { products } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { fixtureSource, shopClient, testDb } from '../test/catalogue.js';
import { SECRET, testApp } from '../test/helpers.js';
import { jobsRoutes } from './jobs.js';

const JOBS_SECRET = 'test-jobs-secret-123';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
});

const post = (
  app: { request: (p: string, i: RequestInit) => Response | Promise<Response> },
  path: string,
  secret?: string,
) => app.request(path, { method: 'POST', headers: secret ? { 'x-jobs-secret': secret } : {} });

describe('POST /jobs/catalogue-sync', () => {
  it('answers 503 while JOBS_SECRET is unset, 401 without the right secret', async () => {
    const off = await testApp();
    closers.push(off.close);
    expect((await post(off.app, '/jobs/catalogue-sync', JOBS_SECRET)).status).toBe(503);

    const on = await testApp({ env: { JOBS_SECRET } });
    closers.push(on.close);
    expect((await post(on.app, '/jobs/catalogue-sync')).status).toBe(401);
    expect((await post(on.app, '/jobs/catalogue-sync', 'wrong-secret')).status).toBe(401);
    const ok = await post(on.app, '/jobs/catalogue-sync', JOBS_SECRET);
    expect(ok.status).toBe(200);
    // The test client has no catalogue, so there is nothing to sync.
    expect(await ok.json()).toEqual({ results: [] });
  });

  it('syncs one client or all, and answers 502 when a sync fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await testDb();
    closers.push(handle.close);
    const env = loadEnv({ SIMULATOR_WEBHOOK_SECRET: SECRET, JOBS_SECRET });
    const shop = shopClient();
    const broken = shopClient({
      id: 'broken',
      channel: {
        type: 'simulator',
        phone_number_id: 'broken-phone',
        display_phone_number: '+351 1',
      },
    });
    const app = jobsRoutes({
      env,
      db: handle.db,
      clients: new ClientRegistry([shop, broken]),
      sourceFor: (client) =>
        client.id === 'broken'
          ? {
              fetchProducts: async () => {
                throw new Error('store down');
              },
            }
          : fixtureSource(),
    });

    const one = await post(app, '/catalogue-sync?client=acme', JOBS_SECRET);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({
      results: [
        {
          ok: true,
          clientId: 'acme',
          total: 7,
          inserted: 7,
          updated: 0,
          unchanged: 0,
          markedUnavailable: 0,
        },
      ],
    });
    expect(await handle.db.select().from(products)).toHaveLength(7);

    const all = await post(app, '/catalogue-sync', JOBS_SECRET);
    expect(all.status).toBe(502);
    expect(await all.json()).toEqual({
      results: [
        expect.objectContaining({ ok: true, clientId: 'acme', unchanged: 7 }),
        { ok: false, clientId: 'broken', error: 'store down' },
      ],
    });

    expect((await post(app, '/catalogue-sync?client=nope', JOBS_SECRET)).status).toBe(404);
  });
});

describe('POST /jobs/keepalive', () => {
  it('touches the database, behind the jobs secret', async () => {
    const t = await testApp({ env: { JOBS_SECRET } });
    closers.push(t.close);
    expect((await post(t.app, '/jobs/keepalive')).status).toBe(401);
    const res = await post(t.app, '/jobs/keepalive', JOBS_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
