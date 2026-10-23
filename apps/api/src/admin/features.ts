/**
 * Every admin feature's routes, mounted under /api/admin/clients/:clientId (WA-022). Each feature
 * lives in apps/api/src/admin/<feature>/routes.ts and exports `(deps: AdminDeps) => Hono<AdminEnv>`.
 * The router has already verified the token and resolved the member before any of these run:
 * read `c.get('admin')` (an AdminContext) and scope every query by `ctx.client.id` and, for
 * branch data, `branchFilter(ctx, table.branchId)`.
 *
 * To add a feature: create its folder and add one line below.
 */
import type { Hono } from 'hono';
import type { AdminEnv } from './context.js';
import type { AdminDeps } from './deps.js';
import { inboxRoutes } from './inbox/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { teamRoutes } from './team/routes.js';

export interface AdminFeature {
  /** Mount path below /api/admin/clients/:clientId, e.g. `/leads`. */
  path: string;
  routes: (deps: AdminDeps) => Hono<AdminEnv>;
}

export const adminFeatures: AdminFeature[] = [
  { path: '/team', routes: teamRoutes },
  { path: '/settings', routes: settingsRoutes },
  { path: '/inbox', routes: inboxRoutes },
  // WA-024 { path: '/leads', routes: leadsRoutes },
  // WA-026 { path: '/knowledge', routes: knowledgeRoutes },
  // WA-027 { path: '/customers', routes: customersRoutes },
  // WA-029 { path: '/overview', routes: overviewRoutes },
];
