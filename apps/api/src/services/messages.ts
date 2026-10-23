import type { ClientConfig, MetaSendMessage, SimChatMessage } from '@wa/shared';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { EventBus } from '../bus.js';
import {
  payloadText,
  toMetaPayload,
  type Channel,
  type OutboundMessage,
} from '../channels/channel.js';
import type { InboundMessage } from '../channels/inbound.js';
import type { Db } from '../db/index.js';
import { contacts, conversations, messages } from '../db/schema.js';
import { ensureCustomer } from '../customers/records.js';

export type ContactRow = typeof contacts.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export class MessageService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly channels: Map<string, Channel>,
  ) {}

  channelFor(client: ClientConfig): Channel {
    const channel = this.channels.get(client.channel.type);
    if (!channel) throw new Error(`No channel registered for type "${client.channel.type}"`);
    return channel;
  }

  /** The contact for this number, created with its customer record (WA-027) if new. */
  async upsertContact(clientId: string, waId: string, name?: string): Promise<ContactRow> {
    const [row] = await this.db
      .insert(contacts)
      .values({ clientId, waId, name })
      .onConflictDoUpdate({
        target: [contacts.clientId, contacts.waId],
        set: name ? { name } : { waId },
      })
      .returning();
    if (!row!.customerId)
      row!.customerId = (await ensureCustomer(this.db, clientId, row!.id)) ?? null;
    return row!;
  }

  /** The contact's open conversation, created if there is none. */
  async openConversation(clientId: string, contactId: string): Promise<ConversationRow> {
    const existing = await this.findOpenConversation(contactId);
    if (existing) return existing;
    await this.db.insert(conversations).values({ clientId, contactId }).onConflictDoNothing();
    // Another request may have created it between the two statements; either way it exists now.
    return (await this.findOpenConversation(contactId))!;
  }

  async findOpenConversation(contactId: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.contactId, contactId), ne(conversations.status, 'closed')))
      .limit(1);
    return row;
  }

  /**
   * Stores an inbound message. Returns undefined when it was already stored, which is how
   * duplicate webhook deliveries are dropped.
   */
  async recordInbound(
    client: ClientConfig,
    inbound: InboundMessage,
  ): Promise<{ conversation: ConversationRow; message: MessageRow } | undefined> {
    const contact = await this.upsertContact(client.id, inbound.from, inbound.profileName);
    const conversation = await this.openConversation(client.id, contact.id);
    const [message] = await this.db
      .insert(messages)
      .values({
        clientId: client.id,
        conversationId: conversation.id,
        direction: 'inbound',
        channelMessageId: inbound.channelMessageId,
        type: inbound.type,
        text: inbound.text,
        payload: inbound.raw,
        status: 'received',
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return undefined;

    await this.db
      .update(conversations)
      .set({ lastActivityAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    this.bus.publish(EventBus.key(client.id, inbound.from), {
      type: 'message',
      message: toSimChatMessage(message),
    });
    return { conversation, message };
  }

  async send(
    client: ClientConfig,
    conversationId: string,
    to: string,
    outbound: OutboundMessage,
    /** WA-023: a reply a team member sent from the inbox. */
    opts: { sentByMemberId?: string } = {},
  ): Promise<MessageRow> {
    const payload = toMetaPayload(to, outbound);
    const { channelMessageId } = await this.channelFor(client).send(client, payload);
    const [row] = await this.db
      .insert(messages)
      .values({
        clientId: client.id,
        conversationId,
        direction: 'outbound',
        channelMessageId,
        type: payload.type,
        text: payloadText(payload),
        payload,
        status: 'sent',
        sentByMemberId: opts.sentByMemberId ?? null,
      })
      .returning();
    const key = EventBus.key(client.id, to);
    this.bus.publish(key, { type: 'typing', on: false });
    this.bus.publish(key, { type: 'message', message: toSimChatMessage(row!) });
    return row!;
  }

  /**
   * Sends without storing the message anywhere: the confirmation that a customer's data was
   * deleted (WA-028) must not leave a new trace of them.
   */
  async sendWithoutHistory(client: ClientConfig, to: string, outbound: OutboundMessage) {
    const payload = toMetaPayload(to, outbound);
    const { channelMessageId } = await this.channelFor(client).send(client, payload);
    const key = EventBus.key(client.id, to);
    this.bus.publish(key, { type: 'typing', on: false });
    this.bus.publish(key, {
      type: 'message',
      message: {
        id: channelMessageId,
        direction: 'outbound',
        timestamp: new Date().toISOString(),
        payload,
      },
    });
  }

  /** Messages of the contact's open conversation, oldest first. */
  async history(
    clientId: string,
    waId: string,
  ): Promise<{ conversation?: ConversationRow; messages: MessageRow[] }> {
    const [contact] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clientId, clientId), eq(contacts.waId, waId)));
    if (!contact) return { messages: [] };
    const conversation = await this.findOpenConversation(contact.id);
    if (!conversation) return { messages: [] };
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.createdAt));
    return { conversation, messages: rows };
  }

  /** Closes the contact's open conversation, so the next message starts a fresh one. */
  async closeConversation(clientId: string, waId: string): Promise<void> {
    const { conversation } = await this.history(clientId, waId);
    if (!conversation) return;
    await this.db
      .update(conversations)
      .set({ status: 'closed' })
      .where(eq(conversations.id, conversation.id));
  }

  /** Sets the status of the contact's open conversation. False when there is none. */
  async setConversationStatus(
    clientId: string,
    waId: string,
    status: 'bot' | 'human',
  ): Promise<boolean> {
    const { conversation } = await this.history(clientId, waId);
    if (!conversation) return false;
    await this.db
      .update(conversations)
      .set({ status })
      .where(eq(conversations.id, conversation.id));
    return true;
  }

  async latestConversations(clientId: string, limit = 20): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.clientId, clientId))
      .orderBy(desc(conversations.lastActivityAt))
      .limit(limit);
  }
}

export function toSimChatMessage(row: MessageRow): SimChatMessage {
  const timestamp = row.createdAt.toISOString();
  if (row.direction === 'inbound') {
    return {
      id: row.channelMessageId,
      direction: 'inbound',
      timestamp,
      text: row.text ?? '',
      status: row.processedAt ? 'read' : 'sent',
    };
  }
  return {
    id: row.channelMessageId,
    direction: 'outbound',
    timestamp,
    payload: row.payload as MetaSendMessage,
  };
}
