/**
 * The team dashboard's inbox (WA-023): conversations, their transcript, takeover and replies.
 * Routes below /api/admin/clients/:clientId/inbox.
 */
import { z } from 'zod';
import type { BackofficeLead, ConversationStatus } from './backoffice.js';
import type { MetaInboundMessage, MetaSendMessage } from './meta.js';

/** List filters: needs a person (status `human`), assigned to me, or everything. */
export const inboxViewSchema = z.enum(['human', 'mine', 'all']);
export type InboxView = z.infer<typeof inboxViewSchema>;

export interface InboxMemberRef {
  id: string;
  name: string | null;
  email: string;
}

/** One row of the inbox list. */
export interface InboxConversation {
  id: string;
  status: ConversationStatus;
  contact: { id: string; name: string | null; phone: string };
  branchId: string | null;
  branchName: string | null;
  assignedTo: InboxMemberRef | null;
  lastActivityAt: string;
  createdAt: string;
  lastMessage: {
    direction: 'inbound' | 'outbound';
    text: string;
    at: string;
    /** Sent by a team member from the inbox (else by the agent, for outbound). */
    byMember: boolean;
  } | null;
  /** Customer messages nobody (agent or person) has answered or read yet. */
  unread: number;
}

/** GET /inbox?view=&branch= */
export interface InboxList {
  conversations: InboxConversation[];
  /** Conversations waiting for a person, in the member's scope (for a badge). */
  needsPerson: number;
}

/** One message of the transcript, with the WhatsApp payload so cards and taps can be drawn. */
export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string;
  at: string;
  /** Outbound: the send-message body. Inbound: the webhook message (taps, images). */
  payload: MetaSendMessage | MetaInboundMessage;
  /** The team member who sent it from the inbox; null for the customer and the agent. */
  sentBy: InboxMemberRef | null;
}

/** GET /inbox/:id */
export interface InboxConversationDetail {
  conversation: InboxConversation;
  messages: InboxMessage[];
  /** Leads, handoffs and order drafts (type `order`) of this conversation. */
  leads: BackofficeLead[];
  /** Members the conversation can be assigned to (they can see its branch). */
  assignable: InboxMemberRef[];
}

export const inboxReplySchema = z.object({
  text: z.string().trim().min(1, 'Escreva uma mensagem.').max(4096),
});
export type InboxReplyBody = z.infer<typeof inboxReplySchema>;

export const inboxAssignSchema = z.object({
  /** null unassigns. */
  memberId: z.uuid().nullable(),
});
export type InboxAssignBody = z.infer<typeof inboxAssignSchema>;

/** Live updates on GET /inbox/stream (SSE). */
export type InboxEvent =
  /** A conversation changed (new message, status, assignment, branch): its new list row. */
  { type: 'conversation'; conversation: InboxConversation };
