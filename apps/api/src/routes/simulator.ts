import { timingSafeEqual } from 'node:crypto';
import type { SimClientSummary, SimEvent, SimSendBody } from '@wa/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { EventBus } from '../bus.js';
import { buildSimulatedWebhook } from '../channels/simulator.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Env } from '../env.js';
import { toSimChatMessage, type MessageService } from '../services/messages.js';

const phoneSchema = z.string().regex(/^\d{6,15}$/, 'phone must be 6 to 15 digits');

const sendBodySchema = z.union([
  z.object({
    phone: phoneSchema,
    name: z.string().min(1).max(60),
    text: z.string().min(1).max(4096),
  }),
  z.object({
    phone: phoneSchema,
    name: z.string().min(1).max(60),
    reply: z.object({
      type: z.enum(['button_reply', 'list_reply']),
      id: z.string().min(1),
      title: z.string().min(1),
    }),
  }),
]);

/**
 * API for the simulator UI. Customer messages are wrapped in Meta's webhook format and go
 * through the normal webhook, so the simulator exercises the same path as real WhatsApp.
 */
export function simulatorRoutes(deps: {
  env: Env;
  clients: ClientRegistry;
  messages: MessageService;
  bus: EventBus;
  /** Delivers a webhook body to POST /webhook/simulator in-process. */
  postWebhook: (body: unknown) => Promise<Response>;
}) {
  const app = new Hono();
  const accessCode = deps.env.SIMULATOR_ACCESS_CODE;

  app.get('/config', (c) => c.json({ accessCodeRequired: Boolean(accessCode) }));

  // Every other route needs the access code when one is set. EventSource cannot send headers,
  // so the stream takes it as a query parameter.
  app.use('*', async (c, next) => {
    if (!accessCode) return next();
    const given = c.req.header('x-access-code') ?? c.req.query('code');
    if (!given || !safeEqual(given, accessCode))
      return c.json({ error: 'access code required' }, 401);
    return next();
  });

  const simClients = () => deps.clients.all().filter((cl) => cl.channel.type === 'simulator');

  app.get('/clients', (c) =>
    c.json(
      simClients().map((cl): SimClientSummary => ({
        id: cl.id,
        name: cl.name,
        displayPhoneNumber: cl.channel.display_phone_number,
        languages: cl.languages,
      })),
    ),
  );

  app.post('/:clientId/messages', async (c) => {
    const client = deps.clients.get(c.req.param('clientId'));
    if (!client || client.channel.type !== 'simulator')
      return c.json({ error: 'unknown client' }, 404);
    const parsed = sendBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);

    const webhook = buildSimulatedWebhook(client, parsed.data as SimSendBody);
    const res = await deps.postWebhook(webhook);
    if (!res.ok) return c.json({ error: `webhook returned ${res.status}` }, 502);
    return c.json({ messageId: webhook.entry[0]!.changes[0]!.value.messages![0]!.id });
  });

  app.get('/:clientId/stream', (c) => {
    const client = deps.clients.get(c.req.param('clientId'));
    const phone = phoneSchema.safeParse(c.req.query('phone'));
    if (!client || !phone.success) return c.json({ error: 'unknown client or bad phone' }, 400);

    return streamSSE(c, async (stream) => {
      const queue: SimEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = deps.bus.subscribe(EventBus.key(client.id, phone.data), (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      const { conversation, messages } = await deps.messages.history(client.id, phone.data);
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'history',
          messages: messages.map(toSimChatMessage),
          conversationStatus: conversation?.status ?? 'bot',
        } satisfies SimEvent),
      });

      while (!stream.aborted) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ data: JSON.stringify(event) });
          continue;
        }
        // Wait for the next event, with a heartbeat so proxies keep the connection open.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (!queue.length && !stream.aborted) await stream.write(': ping\n\n');
      }
    });
  });

  app.post('/:clientId/reset', async (c) => {
    const client = deps.clients.get(c.req.param('clientId'));
    const phone = phoneSchema.safeParse(c.req.query('phone'));
    if (!client || !phone.success) return c.json({ error: 'unknown client or bad phone' }, 400);
    await deps.messages.closeConversation(client.id, phone.data);
    deps.bus.publish(EventBus.key(client.id, phone.data), {
      type: 'history',
      messages: [],
      conversationStatus: 'bot',
    });
    return c.body(null, 204);
  });

  return app;
}

function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
