/** /api/admin/clients/:clientId/settings (WA-022). Admins only. */
import { clientSettingsSchema } from '@wa/shared';
import { Hono } from 'hono';
import { parseBody, requireAdmin, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';

export function settingsRoutes({ settings }: AdminDeps) {
  const routes = new Hono<AdminEnv>();
  routes.use('*', requireAdmin);

  routes.get('/', async (c) => c.json(await settings.view(c.get('admin').client.id)));

  routes.put('/', async (c) => {
    const ctx = c.get('admin');
    const body = await parseBody(c, clientSettingsSchema);
    return c.json(await settings.save(ctx.client.id, body, ctx.member.id));
  });

  routes.delete('/', async (c) => c.json(await settings.reset(c.get('admin').client.id)));

  return routes;
}
