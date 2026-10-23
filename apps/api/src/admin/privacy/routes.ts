/**
 * /api/admin/clients/:clientId/privacy (WA-028), admins only:
 *
 *   GET  /customers?q=                     search by phone or name
 *   GET  /customers/:contactId             one customer
 *   GET  /customers/:contactId/export      ZIP with data.json and media/ (streamed)
 *   POST /customers/:contactId/clear-profile
 *   POST /customers/:contactId/delete      { confirm: name or phone }
 *   GET  /requests?status=pending          privacy requests (from WhatsApp or the team)
 *   POST /requests/:id/approve             { confirm? } carries it out, tells the customer
 *   POST /requests/:id/reject
 *   GET  /retention                        whom the retention job deletes within 7 days
 *   GET  /audit                            who exported, cleared or deleted, and when
 */
import {
  privacyApproveSchema,
  privacyDeleteSchema,
  type PrivacyActionResult,
  type PrivacyAuditEntry,
  type PrivacyCustomer,
  type PrivacyRequestStatus,
  type PrivacyRequestView,
  type PrivacyRetentionView,
} from '@wa/shared';
import { Hono } from 'hono';
import { PrivacyError } from '../../privacy/service.js';
import { adminError, parseBody, requireAdmin, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';

const errorStatus = {
  not_found: 404,
  confirm_mismatch: 400,
  not_pending: 409,
  customer_gone: 409,
} as const;

/** PrivacyError → the dashboard's JSON error. */
async function guard<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PrivacyError) {
      throw adminError(errorStatus[error.code], error.code, error.message);
    }
    throw error;
  }
}

const statuses: PrivacyRequestStatus[] = ['pending', 'done', 'rejected'];

export function privacyRoutes({ privacy }: AdminDeps) {
  const routes = new Hono<AdminEnv>();
  routes.use('*', requireAdmin);

  routes.get('/customers', async (c) => {
    const ctx = c.get('admin');
    const found = await privacy.findCustomers(ctx.client.id, c.req.query('q') ?? '');
    return c.json(found satisfies PrivacyCustomer[]);
  });

  routes.get('/customers/:contactId', async (c) => {
    const ctx = c.get('admin');
    const customer = await privacy.customer(ctx.client.id, c.req.param('contactId'));
    if (!customer) throw adminError(404, 'not_found', 'Cliente não encontrado.');
    return c.json(customer satisfies PrivacyCustomer);
  });

  routes.get('/customers/:contactId/export', async (c) => {
    const ctx = c.get('admin');
    const { stream, filename } = await guard(() =>
      privacy.exportZip(ctx.client, c.req.param('contactId'), ctx.member),
    );
    return c.body(stream, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    });
  });

  routes.post('/customers/:contactId/clear-profile', async (c) => {
    const ctx = c.get('admin');
    const counts = await guard(() =>
      privacy.clearProfile(ctx.client, c.req.param('contactId'), ctx.member),
    );
    return c.json({ counts } satisfies PrivacyActionResult);
  });

  routes.post('/customers/:contactId/delete', async (c) => {
    const ctx = c.get('admin');
    const { confirm } = await parseBody(c, privacyDeleteSchema);
    const { counts } = await guard(() =>
      privacy.deleteCustomer(ctx.client, c.req.param('contactId'), {
        actor: ctx.member,
        confirm,
      }),
    );
    return c.json({ counts } satisfies PrivacyActionResult);
  });

  routes.get('/requests', async (c) => {
    const ctx = c.get('admin');
    const status = c.req.query('status') as PrivacyRequestStatus | undefined;
    if (status && !statuses.includes(status)) {
      throw adminError(400, 'invalid_status', 'Estado desconhecido.');
    }
    return c.json(
      (await privacy.listRequests(ctx.client.id, status)) satisfies PrivacyRequestView[],
    );
  });

  routes.post('/requests/:id/approve', async (c) => {
    const ctx = c.get('admin');
    const { confirm } = await parseBody(c, privacyApproveSchema.default({}));
    const result = await guard(() =>
      privacy.approveRequest(ctx.client, c.req.param('id'), ctx.member, confirm),
    );
    return c.json(result satisfies PrivacyActionResult);
  });

  routes.post('/requests/:id/reject', async (c) => {
    const ctx = c.get('admin');
    const { notified } = await guard(() =>
      privacy.rejectRequest(ctx.client, c.req.param('id'), ctx.member),
    );
    return c.json({ counts: {}, notified } satisfies PrivacyActionResult);
  });

  routes.get('/retention', async (c) => {
    const ctx = c.get('admin');
    return c.json((await privacy.retentionDue(ctx.client)) satisfies PrivacyRetentionView);
  });

  routes.get('/audit', async (c) => {
    const ctx = c.get('admin');
    return c.json((await privacy.auditLog(ctx.client.id)) satisfies PrivacyAuditEntry[]);
  });

  return routes;
}
