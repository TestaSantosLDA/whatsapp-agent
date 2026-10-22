import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClientConfig, MetaSendMessage } from '@wa/shared';
import type { Channel, SendResult } from './channel.js';

/** Real WhatsApp Cloud API channel. Sending arrives with WA-030; only signature checks exist now. */
export class WhatsAppCloudChannel implements Channel {
  readonly type = 'whatsapp_cloud' as const;

  async send(_client: ClientConfig, _payload: MetaSendMessage): Promise<SendResult> {
    throw new Error('WhatsApp Cloud API sending is not implemented yet (WA-030)');
  }

  async markReadAndTyping(): Promise<void> {
    throw new Error('WhatsApp Cloud API sending is not implemented yet (WA-030)');
  }
}

/** Checks Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256(rawBody, appSecret). */
export function verifyMetaSignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
