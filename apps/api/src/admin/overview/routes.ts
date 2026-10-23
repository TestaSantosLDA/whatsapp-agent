/**
 * /api/admin/clients/:clientId/overview (WA-029). The figures are for everyone, scoped to the
 * member's branches (Claude's cost for admins only); the "couldn't answer" list shows customers'
 * messages and leads to uploading documents, so it is for admins.
 *
 *   GET  /?branch=               this week and this month: OverviewView
 *   GET  /products?days=30       most asked products and searches with no result
 *   GET  /gaps?days=30           "couldn't answer", grouped by topic (admins)
 *   POST /gaps/dismiss           { topic } hides the topic's questions so far (admins)
 */
import {
  dismissGapSchema,
  insightsRangeQuerySchema,
  overviewQuerySchema,
  type GapsView,
  type OverviewProductsView,
  type OverviewView,
} from '@wa/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { z } from 'zod';
import { adminError, parseBody, requireAdmin, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';

function query<S extends z.ZodType>(c: Context<AdminEnv>, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw adminError(400, 'invalid_query', `${issue?.path.join('.')}: ${issue?.message}`);
  }
  return parsed.data;
}

export function overviewRoutes({ insights }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    const { branch } = query(c, overviewQuerySchema);
    return c.json((await insights.overview(c.get('admin'), branch)) satisfies OverviewView);
  });

  routes.get('/products', async (c) => {
    const { days } = query(c, insightsRangeQuerySchema);
    const view = await insights.products(c.get('admin').client, insights.lastDays(days));
    return c.json(view satisfies OverviewProductsView);
  });

  routes.get('/gaps', requireAdmin, async (c) => {
    const { days } = query(c, insightsRangeQuerySchema);
    const view = await insights.gaps(c.get('admin').client, insights.lastDays(days));
    return c.json(view satisfies GapsView);
  });

  routes.post('/gaps/dismiss', requireAdmin, async (c) => {
    const { topic } = await parseBody(c, dismissGapSchema);
    await insights.dismiss(c.get('admin'), topic);
    return c.body(null, 204);
  });

  return routes;
}
