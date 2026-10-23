/**
 * /api/admin/clients/:clientId/inbox (WA-023): the team's conversations.
 *
 *   GET  /                ?view=human|mine|all&branch=   list, newest first (InboxList)
 *   GET  /stream          SSE: list rows that changed (InboxEvent), in the member's scope; it
 *                         closes once the token expires or the member is removed or re-scoped
 *   GET  /:id             transcript, leads and order drafts (InboxConversationDetail)
 *   POST /:id/read        the team has read it (unread badge)
 *   POST /:id/takeover    status human, assigned to me: the agent stays silent
 *   POST /:id/assign      { memberId | null }
 *   POST /:id/reply       { text }: a WhatsApp message sent as the member
 *   POST /:id/bot         back to the agent
 */
import { inboxAssignSchema, inboxReplySchema, inboxViewSchema, type InboxEvent } from '@wa/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { decodeJwt } from 'jose';
import { SseQueue } from '../../routes/simulator.js';
import { bearerToken } from '../auth.js';
import { adminError, parseBody, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';

export function inboxRoutes({ inbox }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/', async (c) => {
    const view = inboxViewSchema.safeParse(c.req.query('view') ?? 'all');
    if (!view.success) throw adminError(400, 'invalid_view', 'Filtro desconhecido.');
    const branch = c.req.query('branch') || undefined;
    return c.json(await inbox.list(c.get('admin'), { view: view.data, branch }));
  });

  routes.get('/stream', (c) => {
    const ctx = c.get('admin');
    // The router verified the token, so it has an `exp`.
    const expiresAt = (decodeJwt(bearerToken(c.req)!).exp ?? 0) * 1000;
    return streamSSE(c, async (stream) => {
      const events = new SseQueue<InboxEvent>(stream, (push) =>
        inbox.bus.subscribe(ctx.client.id, (event) => {
          if (inbox.visible(ctx, event.conversation)) push(event);
        }),
      );
      // The stream keeps the context it opened with: check the member again now and then.
      const recheck = setInterval(() => {
        inbox.streamAllowed(ctx, expiresAt).then(
          (ok) => {
            if (!ok) stream.abort();
          },
          (error: unknown) => console.error('[inbox] stream recheck failed', error),
        );
      }, inbox.streamRecheckMs);
      try {
        await events.run();
      } finally {
        clearInterval(recheck);
      }
    });
  });

  routes.get('/:id', async (c) => c.json(await inbox.detail(c.get('admin'), c.req.param('id'))));

  routes.post('/:id/read', async (c) => {
    await inbox.markRead(c.get('admin'), c.req.param('id'));
    return c.body(null, 204);
  });

  routes.post('/:id/takeover', async (c) =>
    c.json(await inbox.takeOver(c.get('admin'), c.req.param('id'))),
  );

  routes.post('/:id/assign', async (c) => {
    const body = await parseBody(c, inboxAssignSchema);
    return c.json(await inbox.assign(c.get('admin'), c.req.param('id'), body.memberId));
  });

  routes.post('/:id/reply', async (c) => {
    const body = await parseBody(c, inboxReplySchema);
    return c.json(await inbox.reply(c.get('admin'), c.req.param('id'), body.text), 201);
  });

  routes.post('/:id/bot', async (c) =>
    c.json(await inbox.returnToBot(c.get('admin'), c.req.param('id'))),
  );

  return routes;
}
