/**
 * The back-office panel (WA-018): what the client's team gets out of a conversation. Pushed to
 * the simulator UI over Server-Sent Events, per client and customer phone.
 */

export interface BackofficeLead {
  id: string;
  createdAt: string;
  /** Request type from client config (info, quote, sample, order) or `handoff`. */
  type: string;
  branchId: string | null;
  branchName: string | null;
  status: string;
  /** Who follows the lead up (WA-024). */
  ownerId?: string | null;
  ownerName?: string | null;
  /** Everything the agent collected: name, location, area, summary, … */
  fields: Record<string, unknown>;
}

export interface BackofficeEmail {
  id: string;
  createdAt: string;
  /** lead, handoff, order_draft or inbox_alert (WA-023). */
  kind: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: string | null;
  error: string | null;
}

export interface BackofficeToolCall {
  name: string;
  input: unknown;
  ok: boolean;
  output?: string;
  error?: string;
  ms: number;
}

/** One agent turn, for the trace view. */
export interface BackofficeTurn {
  id: string;
  createdAt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
  toolCalls: BackofficeToolCall[];
}

export type ConversationStatus = 'bot' | 'human' | 'closed';

export type BackofficeEvent =
  /** Sent first on every (re)connect: the state of the customer's open conversation. */
  | {
      type: 'snapshot';
      conversationStatus: ConversationStatus;
      leads: BackofficeLead[];
      emails: BackofficeEmail[];
      turns: BackofficeTurn[];
    }
  | { type: 'lead'; lead: BackofficeLead }
  | { type: 'email'; email: BackofficeEmail }
  | { type: 'turn'; turn: BackofficeTurn }
  | { type: 'conversation'; status: ConversationStatus };
