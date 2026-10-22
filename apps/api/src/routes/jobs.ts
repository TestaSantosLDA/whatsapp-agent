import { timingSafeEqual } from 'node:crypto';
import type { ClientConfig } from '@wa/shared';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { CatalogueSource } from '../catalogue/source.js';
import { sourceForClient } from '../catalogue/source.js';
import { syncClients } from '../catalogue/sync.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import type { Env } from '../env.js';
import type { RunResult } from '../queue/cloud-tasks.js';

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
  /** Set when QUEUE=cloudtasks: runs a job that Cloud Tasks delivers to /jobs/run/:name. */
  runJob?: (name: string, payload: unknown, retryCount: number) => Promise<RunResult>;
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

  // Weekly keep-alive: Supabase pauses a free project after 7 days without database activity.
  // The hourly catalogue sync already counts; this one also works for clients with no catalogue.
  app.post('/keepalive', async (c) => {
    await deps.db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  // Cloud Tasks delivery of a queued job. 500 asks Cloud Tasks to retry; after the last attempt
  // the queue runs the failure handler and answers 200.
  app.post('/run/:name', async (c) => {
    if (!deps.runJob) return c.text('Queue is not cloudtasks', 404);
    const payload: unknown = await c.req.json().catch(() => undefined);
    if (payload === undefined) return c.text('Bad request', 400);
    const retryCount = Number(c.req.header('x-cloudtasks-taskretrycount') ?? 0) || 0;
    const result = await deps.runJob(c.req.param('name'), payload, retryCount);
    if (result === 'unknown-job') return c.text('Unknown job', 404);
    return result === 'retry' ? c.text('Retry', 500) : c.json({ ok: true });
  });

  return app;
}

function safeEqual(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
