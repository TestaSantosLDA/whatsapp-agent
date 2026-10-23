import type {
  BackofficeEmail,
  BackofficeEvent,
  BackofficeLead,
  BackofficeToolCall,
  BackofficeTurn,
  ClientConfig,
  ConversationStatus,
} from '@wa/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { EventBus } from '../bus.js';
import type { Db } from '../db/index.js';
import { agentRuns, contacts, conversations, leads, outbox, teamMembers } from '../db/schema.js';

type LeadRow = typeof leads.$inferSelect;
type EmailRow = typeof outbox.$inferSelect;
type TurnRow = typeof agentRuns.$inferSelect;

/**
 * Feeds the back-office panel (WA-018): leads, emails, agent turns and the conversation status,
 * per client and customer phone. Whoever writes one of those rows publishes it here.
 */
export class BackofficeService {
  constructor(
    private readonly db: Db,
    readonly bus: EventBus<BackofficeEvent>,
  ) {}

  publishLead(client: ClientConfig, phone: string, row: LeadRow, ownerName?: string | null): void {
    this.publish(client.id, phone, {
      type: 'lead',
      lead: toBackofficeLead(client, row, ownerName),
    });
  }

  publishEmail(clientId: string, phone: string, row: EmailRow): void {
    this.publish(clientId, phone, { type: 'email', email: toBackofficeEmail(row) });
  }

  publishTurn(clientId: string, phone: string, row: TurnRow): void {
    this.publish(clientId, phone, { type: 'turn', turn: toBackofficeTurn(row) });
  }

  publishStatus(clientId: string, phone: string, status: ConversationStatus): void {
    this.publish(clientId, phone, { type: 'conversation', status });
  }

  /** The state of the customer's open conversation, for a panel that just connected. */
  async snapshot(client: ClientConfig, phone: string): Promise<BackofficeEvent> {
    const [conversation] = await this.db
      .select({ id: conversations.id, status: conversations.status })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(
        and(
          eq(contacts.clientId, client.id),
          eq(contacts.waId, phone),
          ne(conversations.status, 'closed'),
        ),
      );
    if (!conversation) {
      return { type: 'snapshot', conversationStatus: 'bot', leads: [], emails: [], turns: [] };
    }
    const [leadRows, emailRows, turnRows] = await Promise.all([
      this.db
        .select({ lead: leads, ownerName: teamMembers.name, ownerEmail: teamMembers.email })
        .from(leads)
        .leftJoin(teamMembers, eq(teamMembers.id, leads.ownerMemberId))
        .where(eq(leads.conversationId, conversation.id))
        .orderBy(asc(leads.createdAt)),
      this.db
        .select()
        .from(outbox)
        .where(eq(outbox.conversationId, conversation.id))
        .orderBy(asc(outbox.createdAt)),
      this.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.conversationId, conversation.id))
        .orderBy(asc(agentRuns.createdAt)),
    ]);
    return {
      type: 'snapshot',
      conversationStatus: conversation.status,
      leads: leadRows.map((r) => toBackofficeLead(client, r.lead, r.ownerName ?? r.ownerEmail)),
      emails: emailRows.map(toBackofficeEmail),
      turns: turnRows.map(toBackofficeTurn),
    };
  }

  private publish(clientId: string, phone: string, event: BackofficeEvent): void {
    this.bus.publish(EventBus.key(clientId, phone), event);
  }
}

export function toBackofficeLead(
  client: ClientConfig,
  row: LeadRow,
  ownerName?: string | null,
): BackofficeLead {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    type: row.type,
    branchId: row.branchId,
    branchName: client.branches.find((b) => b.id === row.branchId)?.name ?? null,
    status: row.status,
    ownerId: row.ownerMemberId,
    ownerName: ownerName ?? null,
    fields: row.fields as Record<string, unknown>,
  };
}

export function toBackofficeEmail(row: EmailRow): BackofficeEmail {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    to: row.to,
    subject: row.subject,
    body: row.body,
    sentAt: row.sentAt?.toISOString() ?? null,
    error: row.error,
  };
}

export function toBackofficeTurn(row: TurnRow): BackofficeTurn {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    latencyMs: row.latencyMs,
    error: row.error,
    toolCalls: row.toolCalls as BackofficeToolCall[],
  };
}
