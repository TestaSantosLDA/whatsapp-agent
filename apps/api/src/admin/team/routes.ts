/** /api/admin/clients/:clientId/team: the client's team (WA-022). Changes are admin only. */
import { inviteMemberSchema, updateMemberSchema, type AdminMember } from '@wa/shared';
import { Hono } from 'hono';
import { adminError, parseBody, requireAdmin, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';
import { toAdminMember } from './service.js';

export function teamRoutes({ team }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    const rows = await team.list(c.get('admin').client.id);
    return c.json(rows.map(toAdminMember) satisfies AdminMember[]);
  });

  routes.post('/', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    const body = await parseBody(c, inviteMemberSchema);
    return c.json(await team.invite(ctx.client.id, body, ctx.member), 201);
  });

  routes.post('/:id/invite', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    const row = await team.get(ctx.client.id, c.req.param('id'));
    if (!row) throw adminError(404, 'not_found', 'Membro não encontrado.');
    if (row.userId) throw adminError(409, 'already_active', 'Esta pessoa já entrou no painel.');
    return c.json(await team.resendInvite(row));
  });

  routes.patch('/:id', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    const body = await parseBody(c, updateMemberSchema);
    const row = await team.update(ctx.client.id, c.req.param('id'), body);
    return c.json(toAdminMember(row));
  });

  routes.delete('/:id', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    await team.remove(ctx.client.id, c.req.param('id'));
    return c.body(null, 204);
  });

  return routes;
}
