import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { InvalidPayloadError, parseInbound } from '../channels/inbound.js';
import { verifyMetaSignature } from '../channels/whatsapp-cloud.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Env } from '../env.js';
import {
  PROCESS_CONVERSATION,
  type ProcessConversationPayload,
} from '../jobs/process-conversation.js';
import type { Queue } from '../queue/queue.js';
import type { MessageService } from '../services/messages.js';

const CHANNEL_TYPES = { simulator: 'simulator', whatsapp: 'whatsapp_cloud' } as const;

/**
 * POST /webhook/:channel receives Cloud API webhook bodies (from Meta, or the simulator in the
 * same format), stores each message once, queues a turn, and answers 200 straight away.
 */
export function webhookRoutes(deps: {
  env: Env;
  clients: ClientRegistry;
  messages: MessageService;
  queue: Queue;
}) {
  const app = new Hono();

  // Meta's one-time subscription handshake.
  app.get('/whatsapp', (c) => {
    const token = deps.env.WHATSAPP_VERIFY_TOKEN;
    if (
      token &&
      c.req.query('hub.mode') === 'subscribe' &&
      c.req.query('hub.verify_token') === token
    ) {
      return c.text(c.req.query('hub.challenge') ?? '');
    }
    return c.text('Forbidden', 403);
  });

  app.post('/:channel', async (c) => {
    const channel = c.req.param('channel');
    if (!(channel in CHANNEL_TYPES)) return c.text('Not found', 404);
    const channelType = CHANNEL_TYPES[channel as keyof typeof CHANNEL_TYPES];
    const raw = await c.req.text();

    if (channelType === 'simulator') {
      if (!safeEqual(c.req.header('x-simulator-secret'), deps.env.SIMULATOR_WEBHOOK_SECRET)) {
        return c.text('Unauthorized', 401);
      }
    } else {
      const secret = deps.env.WHATSAPP_APP_SECRET;
      if (!secret) return c.text('WhatsApp channel not configured', 503);
      if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256'), secret)) {
        return c.text('Unauthorized', 401);
      }
    }

    let inbound;
    try {
      inbound = parseInbound(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof InvalidPayloadError) {
        return c.text('Bad request', 400);
      }
      throw error;
    }

    const stored: string[] = [];
    for (const message of inbound) {
      const client = deps.clients.getByPhoneNumberId(message.phoneNumberId);
      // Unknown or mismatched numbers are acknowledged anyway, so Meta does not retry forever.
      if (!client || client.channel.type !== channelType) {
        console.warn(
          `[webhook] no ${channelType} client for phone_number_id ${message.phoneNumberId}`,
        );
        continue;
      }
      const result = await deps.messages.recordInbound(client, message);
      if (!result) continue; // duplicate delivery
      stored.push(message.channelMessageId);
      await deps.queue.enqueue<ProcessConversationPayload>({
        name: PROCESS_CONVERSATION,
        key: result.conversation.id,
        payload: { clientId: client.id, conversationId: result.conversation.id },
      });
    }
    return c.json({ ok: true, stored });
  });

  return app;
}

function safeEqual(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
