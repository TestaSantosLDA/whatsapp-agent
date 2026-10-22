import { randomUUID } from 'node:crypto';
import type { ClientConfig, MetaSendMessage, MetaWebhook, SimSendBody } from '@wa/shared';
import { EventBus } from '../bus.js';
import type { Channel, SendResult } from './channel.js';

/**
 * Delivers messages to the simulator UI instead of WhatsApp. Persisting the message is done by
 * the caller, so this only pushes events to whoever is watching that customer's chat.
 */
export class SimulatorChannel implements Channel {
  readonly type = 'simulator' as const;

  constructor(private readonly bus: EventBus) {}

  async send(_client: ClientConfig, _payload: MetaSendMessage): Promise<SendResult> {
    // The SSE event is published by MessageService once the message is stored.
    return { channelMessageId: `wamid.sim-${randomUUID()}` };
  }

  async markReadAndTyping(client: ClientConfig, to: string, messageId: string): Promise<void> {
    const key = EventBus.key(client.id, to);
    this.bus.publish(key, { type: 'status', messageId, status: 'read' });
    this.bus.publish(key, { type: 'typing', on: true });
  }
}

/** Wraps a simulated customer message in the exact webhook body Meta would send. */
export function buildSimulatedWebhook(client: ClientConfig, body: SimSendBody): MetaWebhook {
  const id = `wamid.sim-${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message =
    'text' in body
      ? { from: body.phone, id, timestamp, type: 'text', text: { body: body.text } }
      : {
          from: body.phone,
          id,
          timestamp,
          type: 'interactive',
          interactive:
            body.reply.type === 'button_reply'
              ? {
                  type: 'button_reply' as const,
                  button_reply: { id: body.reply.id, title: body.reply.title },
                }
              : {
                  type: 'list_reply' as const,
                  list_reply: { id: body.reply.id, title: body.reply.title },
                },
        };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: `sim-waba-${client.id}`,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: client.channel.display_phone_number,
                phone_number_id: client.channel.phone_number_id,
              },
              contacts: [{ profile: { name: body.name }, wa_id: body.phone }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}
