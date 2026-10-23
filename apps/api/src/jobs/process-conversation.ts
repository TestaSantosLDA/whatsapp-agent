import type { ClientConfig } from '@wa/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { OutboundMessage } from '../channels/channel.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import type { BackofficeService } from '../services/backoffice.js';
import { contacts, conversations, messages } from '../db/schema.js';
import type {
  ContactRow,
  ConversationRow,
  MessageRow,
  MessageService,
} from '../services/messages.js';

export const PROCESS_CONVERSATION = 'process-conversation';

export interface ProcessConversationPayload {
  clientId: string;
  conversationId: string;
}

export interface TurnInput {
  client: ClientConfig;
  conversation: ConversationRow;
  contact: ContactRow;
  /** Customer messages not answered yet, oldest first. Several when the customer typed quickly. */
  newMessages: MessageRow[];
}

/** Decides what to answer. The echo responder now, the Claude agent from WA-009. */
export interface Responder {
  respond(input: TurnInput): Promise<OutboundMessage[]>;
  /** Forget anything cached for a client: its settings changed (WA-022). */
  invalidate?(clientId: string): void;
}

/**
 * Answers every unanswered customer message of a conversation in one turn. Jobs for the same
 * conversation run one at a time, so a job that finds nothing left to answer simply returns.
 */
export function processConversation(deps: {
  db: Db;
  clients: ClientRegistry;
  messages: MessageService;
  responder: Responder;
  /**
   * Customers often send several short messages in a row. The turn waits until the newest one is
   * this old, so they are answered together in one reply.
   */
  debounceMs?: number;
}) {
  const debounceMs = deps.debounceMs ?? 1500;
  const fetchPending = (conversationId: string) =>
    deps.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          isNull(messages.processedAt),
        ),
      )
      .orderBy(asc(messages.createdAt));

  return async ({ clientId, conversationId }: ProcessConversationPayload): Promise<void> => {
    const client = deps.clients.get(clientId);
    if (!client) throw new Error(`Unknown client "${clientId}"`);

    let pending = await fetchPending(conversationId);
    if (pending.length === 0) return;

    const [row] = await deps.db
      .select({ conversation: conversations, contact: contacts })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, conversationId));
    if (!row) throw new Error(`Unknown conversation "${conversationId}"`);
    const { conversation, contact } = row;

    // Show the customer their messages were read and that we are typing, then wait for the burst
    // to end, marking any message that arrives meanwhile.
    const channel = deps.messages.channelFor(client);
    const marked = new Set<string>();
    const markNew = async () => {
      for (const m of pending) {
        if (marked.has(m.id)) continue;
        marked.add(m.id);
        await channel.markReadAndTyping(client, contact.waId, m.channelMessageId);
      }
    };
    await markNew();
    for (;;) {
      const wait = pending.at(-1)!.createdAt.getTime() + debounceMs - Date.now();
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
      pending = await fetchPending(conversationId);
      await markNew();
    }

    // A person has taken over: the bot stays silent.
    const replies =
      conversation.status === 'human'
        ? []
        : await deps.responder.respond({ client, conversation, contact, newMessages: pending });

    for (const reply of replies) {
      await deps.messages.send(client, conversation.id, contact.waId, reply);
    }

    // Only now are the messages answered. If a send fails, the retry answers them again (a
    // partial failure can repeat a reply), and after the last retry the failure handler hands over.
    await deps.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(
        inArray(
          messages.id,
          pending.map((m) => m.id),
        ),
      );
  };
}

/** After the last retry fails: apologise, hand the conversation to a person, stop retrying. */
export function onProcessConversationFailure(deps: {
  db: Db;
  clients: ClientRegistry;
  messages: MessageService;
  backoffice?: BackofficeService;
}) {
  return async (
    { clientId, conversationId }: ProcessConversationPayload,
    error: unknown,
  ): Promise<void> => {
    console.error(`[agent] turn failed for conversation ${conversationId}`, error);
    const client = deps.clients.get(clientId);
    const [row] = await deps.db
      .select({ contact: contacts })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, conversationId));
    if (!client || !row) return;

    await deps.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.processedAt)));
    await deps.db
      .update(conversations)
      .set({ status: 'human' })
      .where(eq(conversations.id, conversationId));
    deps.backoffice?.publishStatus(clientId, row.contact.waId, 'human');
    const english = row.contact.language === 'en';
    await deps.messages.send(client, conversationId, row.contact.waId, {
      type: 'text',
      text: english
        ? 'Sorry, I ran into a technical problem. A colleague will reply to you shortly.'
        : 'Desculpe, tive um problema técnico. Um colega vai responder-lhe em breve.',
    });
  };
}
