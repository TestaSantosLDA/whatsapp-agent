import { timingSafeEqual } from 'node:crypto';
import type { ClientConfig } from '@wa/shared';
import { Hono } from 'hono';
import type { CatalogueSource } from '../catalogue/source.js';
import { sourceForClient } from '../catalogue/source.js';
import { syncClients } from '../catalogue/sync.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import type { Env } from '../env.js';

/**
 * Endpoints for schedulers (Cloud Scheduler in prod). Every call needs the `x-jobs-secret`
 * header; while JOBS_SECRET is unset the routes answer 503, so a deploy without it exposes
 * nothing.
 */
export function jobsRoutes(deps: {
  env: Env;
  db: Db;
  clients: ClientRegistry;
  sourceFor?: (client: ClientConfig) => CatalogueSource | undefined;
}) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const secret = deps.env.JOBS_SECRET;
    if (!secret) return c.text('Jobs not configured', 503);
    if (!safeEqual(c.req.header('x-jobs-secret'), secret)) return c.text('Unauthorized', 401);
    await next();
  });

  // Hourly catalogue sync. `?client=<id>` syncs one client. Answers 502 when any sync failed,
  // so the scheduler records the failure and retries.
  app.post('/catalogue-sync', async (c) => {
    const id = c.req.query('client');
    let clients = deps.clients.all();
    if (id) {
      const client = deps.clients.get(id);
      if (!client) return c.json({ error: `unknown client "${id}"` }, 404);
      if (!client.catalogue) return c.json({ error: `client "${id}" has no catalogue` }, 400);
      clients = [client];
    }
    const results = await syncClients({
      db: deps.db,
      clients,
      sourceFor: deps.sourceFor ?? ((client) => sourceForClient(client)),
    });
    return c.json({ results }, results.every((r) => r.ok) ? 200 : 502);
  });

  return app;
}

function safeEqual(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
