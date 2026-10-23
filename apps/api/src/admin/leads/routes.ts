/**
 * /api/admin/clients/:clientId/leads: the leads pipeline (WA-024). Sales members see and change
 * the leads of their branches; admins every lead.
 *
 *   GET   /                 list: ?branch=&type=&status=&owner=me|none|<id>&q=&limit=&offset=
 *   GET   /export.csv       the same filters, as CSV for Excel
 *   GET   /:id              lead page: fields, attachments, notes, activity, possible owners
 *   PATCH /:id/status       { status, lostReason?, note? } (lost needs a reason)
 *   PATCH /:id/owner        { ownerId | null }
 *   POST  /:id/notes        { body }
 */
import {
  addLeadNoteSchema,
  leadListQuerySchema,
  updateLeadOwnerSchema,
  updateLeadStatusSchema,
  type AdminLeadDetail,
  type AdminLeadList,
  type AdminLeadNote,
} from '@wa/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { adminError, parseBody, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';
import type { LeadFilters } from './service.js';

function filters(c: Context<AdminEnv>): LeadFilters {
  const parsed = leadListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw adminError(400, 'invalid_query', `${issue?.path.join('.')}: ${issue?.message}`);
  }
  return parsed.data;
}

export function leadsRoutes({ leads }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    return c.json((await leads.list(c.get('admin'), filters(c))) satisfies AdminLeadList);
  });

  routes.get('/export.csv', async (c) => {
    const ctx = c.get('admin');
    const csv = await leads.exportCsv(ctx, { ...filters(c), offset: 0 });
    const day = new Date().toISOString().slice(0, 10);
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="pedidos-${ctx.client.id}-${day}.csv"`,
      'cache-control': 'no-store',
    });
  });

  routes.get('/:id', async (c) => {
    return c.json(
      (await leads.detail(c.get('admin'), c.req.param('id'))) satisfies AdminLeadDetail,
    );
  });

  routes.patch('/:id/status', async (c) => {
    const body = await parseBody(c, updateLeadStatusSchema);
    return c.json(
      (await leads.changeStatus(c.get('admin'), c.req.param('id'), body)) satisfies AdminLeadDetail,
    );
  });

  routes.patch('/:id/owner', async (c) => {
    const body = await parseBody(c, updateLeadOwnerSchema);
    return c.json(
      (await leads.changeOwner(
        c.get('admin'),
        c.req.param('id'),
        body.ownerId,
      )) satisfies AdminLeadDetail,
    );
  });

  routes.post('/:id/notes', async (c) => {
    const body = await parseBody(c, addLeadNoteSchema);
    const note = await leads.addNote(c.get('admin'), c.req.param('id'), body.body);
    return c.json(note satisfies AdminLeadNote, 201);
  });

  return routes;
}
