import type { ClientConfig, MetaSendMessage } from '@wa/shared';

/** What the agent wants to say, before it is turned into a WhatsApp payload. */
export type OutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'document'; url: string; filename?: string; caption?: string }
  | {
      type: 'buttons';
      body: string;
      header?: string;
      footer?: string;
      buttons: { id: string; title: string }[];
    }
  | {
      type: 'list';
      body: string;
      button: string;
      header?: string;
      footer?: string;
      sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
    };

export interface SendResult {
  channelMessageId: string;
}

/** A way of reaching customers. The agent never knows which one it is talking through. */
export interface Channel {
  readonly type: ClientConfig['channel']['type'];
  send(client: ClientConfig, payload: MetaSendMessage): Promise<SendResult>;
  /** Marks a customer message as read and shows "typing…" until the next send. */
  markReadAndTyping(client: ClientConfig, to: string, messageId: string): Promise<void>;
}

/** Turns an OutboundMessage into the Cloud API send-message body. */
export function toMetaPayload(to: string, message: OutboundMessage): MetaSendMessage {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to } as const;
  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: message.text, preview_url: true } };
    case 'image':
      return { ...base, type: 'image', image: { link: message.url, caption: message.caption } };
    case 'document':
      return {
        ...base,
        type: 'document',
        document: { link: message.url, filename: message.filename, caption: message.caption },
      };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: message.header ? { type: 'text', text: message.header } : undefined,
          body: { text: message.body },
          footer: message.footer ? { text: message.footer } : undefined,
          action: {
            buttons: message.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: message.header ? { type: 'text', text: message.header } : undefined,
          body: { text: message.body },
          footer: message.footer ? { text: message.footer } : undefined,
          action: { button: message.button, sections: message.sections },
        },
      };
  }
}

/** A plain-text view of an outbound payload, stored for history and search. */
export function payloadText(payload: MetaSendMessage): string {
  switch (payload.type) {
    case 'text':
      return payload.text.body;
    case 'image':
      return payload.image.caption ?? '[image]';
    case 'document':
      return payload.document.caption ?? `[document] ${payload.document.filename ?? ''}`.trim();
    case 'interactive':
      return payload.interactive.body.text;
  }
}
