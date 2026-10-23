/**
 * /api/admin/clients/:clientId/quotes: quote drafts (WA-025). Sales members work on the quotes
 * of their branches' leads; admins on every quote.
 *
 *   GET    /?lead=<id>     the lead's quotes, newest first
 *   POST   /               { leadId }: a new draft prefilled from the lead (201)
 *   GET    /:id            the quote with its totals
 *   PUT    /:id            the edited draft (409 once sent)
 *   DELETE /:id            deletes a draft (204)
 *   GET    /:id/pdf        the PDF: a "Rascunho" preview for drafts, the sent file otherwise
 *   POST   /:id/send       { channel: whatsapp | email, email?, message? }
 *
 * And, outside the dashboard, GET /static/quotes/:token/:file: the PDF of a sent quote behind an
 * unguessable link, for WhatsApp to fetch the document from.
 */
import {
  createQuoteSchema,
  quoteDraftSchema,
  sendQuoteSchema,
  type QuoteDetail,
  type QuoteListItem,
} from '@wa/shared';
import { Hono } from 'hono';
import { adminError, parseBody, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';
import type { QuotesService } from './service.js';

export function quotesRoutes({ quotes }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    const lead = c.req.query('lead');
    if (!lead) throw adminError(400, 'invalid_query', 'Indique o pedido (lead).');
    return c.json((await quotes.listForLead(c.get('admin'), lead)) satisfies QuoteListItem[]);
  });

  routes.post('/', async (c) => {
    const body = await parseBody(c, createQuoteSchema);
    return c.json((await quotes.create(c.get('admin'), body.leadId)) satisfies QuoteDetail, 201);
  });

  routes.get('/:id', async (c) => {
    return c.json((await quotes.detail(c.get('admin'), c.req.param('id'))) satisfies QuoteDetail);
  });

  routes.put('/:id', async (c) => {
    const body = await parseBody(c, quoteDraftSchema);
    return c.json(
      (await quotes.update(c.get('admin'), c.req.param('id'), body)) satisfies QuoteDetail,
    );
  });

  routes.delete('/:id', async (c) => {
    await quotes.remove(c.get('admin'), c.req.param('id'));
    return c.body(null, 204);
  });

  routes.get('/:id/pdf', async (c) => {
    const file = await quotes.pdf(c.get('admin'), c.req.param('id'));
    return c.body(file.content as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${file.filename}"`,
      'cache-control': 'no-store',
    });
  });

  routes.post('/:id/send', async (c) => {
    const body = await parseBody(c, sendQuoteSchema);
    return c.json(
      (await quotes.send(c.get('admin'), c.req.param('id'), body)) satisfies QuoteDetail,
    );
  });

  return routes;
}

/** GET /static/quotes/:token/:file, public: the link a WhatsApp document points to. */
export function publicQuoteRoutes(quotes: QuotesService) {
  const routes = new Hono();
  routes.get('/:token/:file', async (c) => {
    const file = await quotes.publicPdf(c.req.param('token'));
    if (!file) return c.text('Not found', 404);
    return c.body(file.content as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${file.filename}"`,
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    });
  });
  return routes;
}
