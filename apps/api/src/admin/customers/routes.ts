/**
 * /api/admin/clients/:clientId/customers: customer records and profiles (WA-027). Admins see
 * every record; sales the records with a lead on their branches.
 *
 *   GET    /                          list: ?q=&role=&limit=&offset=
 *   GET    /by-contact/:contactId     the record of a WhatsApp contact (for the inbox, WA-023)
 *   GET    /:id                       record page: numbers, conversations, leads, notes, profile
 *   PATCH  /:id                       { name?, company?, nif?, role?, regions? }
 *   POST   /:id/notes                 { body }
 *   POST   /:id/contacts              { phone } link a WhatsApp number (merges its record)
 *   DELETE /:id/contacts/:contactId   unlink a number (it gets a record of its own)
 *   PUT    /:id/profile/:field        { value?, locked? } the team sets a field or its lock
 *   DELETE /:id/profile/:field        removes a field
 *   POST   /:id/profile/clear         "clear profile" (WA-028): removes it, stops profiling
 */
import {
  addCustomerNoteSchema,
  customerListQuerySchema,
  linkCustomerContactSchema,
  setProfileFieldSchema,
  updateCustomerSchema,
  type CustomerDetail,
  type CustomerList,
} from '@wa/shared';
import { Hono } from 'hono';
import { adminError, parseBody, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';

export function customersRoutes({ customers }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    const parsed = customerListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw adminError(400, 'invalid_query', `${issue?.path.join('.')}: ${issue?.message}`);
    }
    return c.json((await customers.list(c.get('admin'), parsed.data)) satisfies CustomerList);
  });

  routes.get('/by-contact/:contactId', async (c) =>
    c.json(
      (await customers.byContact(
        c.get('admin'),
        c.req.param('contactId'),
      )) satisfies CustomerDetail,
    ),
  );

  routes.get('/:id', async (c) =>
    c.json((await customers.detail(c.get('admin'), c.req.param('id'))) satisfies CustomerDetail),
  );

  routes.patch('/:id', async (c) => {
    const body = await parseBody(c, updateCustomerSchema);
    return c.json(
      (await customers.update(c.get('admin'), c.req.param('id'), body)) satisfies CustomerDetail,
    );
  });

  routes.post('/:id/notes', async (c) => {
    const { body } = await parseBody(c, addCustomerNoteSchema);
    return c.json(
      (await customers.addNote(c.get('admin'), c.req.param('id'), body)) satisfies CustomerDetail,
      201,
    );
  });

  routes.post('/:id/contacts', async (c) => {
    const { phone } = await parseBody(c, linkCustomerContactSchema);
    return c.json(
      (await customers.linkContact(
        c.get('admin'),
        c.req.param('id'),
        phone,
      )) satisfies CustomerDetail,
    );
  });

  routes.delete('/:id/contacts/:contactId', async (c) =>
    c.json(
      (await customers.unlinkContact(
        c.get('admin'),
        c.req.param('id'),
        c.req.param('contactId'),
      )) satisfies CustomerDetail,
    ),
  );

  routes.post('/:id/profile/clear', async (c) =>
    c.json(
      (await customers.clearProfile(c.get('admin'), c.req.param('id'))) satisfies CustomerDetail,
    ),
  );

  routes.put('/:id/profile/:field', async (c) => {
    const body = await parseBody(c, setProfileFieldSchema);
    return c.json(
      (await customers.setProfileField(
        c.get('admin'),
        c.req.param('id'),
        c.req.param('field'),
        body,
      )) satisfies CustomerDetail,
    );
  });

  routes.delete('/:id/profile/:field', async (c) =>
    c.json(
      (await customers.removeProfileField(
        c.get('admin'),
        c.req.param('id'),
        c.req.param('field'),
      )) satisfies CustomerDetail,
    ),
  );

  return routes;
}
