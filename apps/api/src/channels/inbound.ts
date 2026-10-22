import { metaWebhookSchema, type MetaInboundMessage } from '@wa/shared';

export interface InboundMessage {
  /** phone_number_id of the business number the message was sent to. */
  phoneNumberId: string;
  from: string;
  profileName?: string;
  channelMessageId: string;
  timestamp: Date;
  type: string;
  /** Plain-text view: the text, the tapped button or row title, or an image caption. */
  text: string;
  raw: MetaInboundMessage;
}

export class InvalidPayloadError extends Error {}

/** Parses a Cloud API webhook body. Status callbacks and unknown fields are ignored. */
export function parseInbound(body: unknown): InboundMessage[] {
  const parsed = metaWebhookSchema.safeParse(body);
  if (!parsed.success) throw new InvalidPayloadError(parsed.error.message);

  const result: InboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const { metadata, contacts = [], messages = [] } = change.value;
      for (const m of messages) {
        result.push({
          phoneNumberId: metadata.phone_number_id,
          from: m.from,
          profileName: contacts.find((c) => c.wa_id === m.from)?.profile.name,
          channelMessageId: m.id,
          timestamp: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          text: textOf(m),
          raw: m,
        });
      }
    }
  }
  return result;
}

function textOf(m: MetaInboundMessage): string {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? '';
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'image':
      return m.image?.caption ? `[image] ${m.image.caption}` : '[image]';
    default:
      return `[${m.type}]`;
  }
}
