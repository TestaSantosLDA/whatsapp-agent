/**
 * The dashboard inbox (WA-023): conversations as the team sees them, takeover, replies as a
 * person, return to bot, assignment, live updates and email alerts.
 *
 * Live updates: the service listens to every event of the simulator/chat bus (messages) and the
 * back-office bus (status, leads), reloads the conversation's list row and publishes it on its own
 * bus, keyed by client id. The inbox stream filters those rows by the member's scope.
 */
import type {
  ClientConfig,
  InboxConversation,
  InboxConversationDetail,
  InboxEvent,
  InboxList,
  InboxMemberRef,
  InboxMessage,
  InboxView,
  MetaInboundMessage,
  MetaSendMessage,
  BackofficeEvent,
  SimEvent,
} from '@wa/shared';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { EventBus } from '../../bus.js';
import type { ClientRegistry } from '../../clients/registry.js';
import type { Db } from '../../db/index.js';
import { contacts, conversations, leads, messages, teamMembers } from '../../db/schema.js';
import type { Mailer } from '../../mail/mailer.js';
import { toBackofficeLead, type BackofficeService } from '../../services/backoffice.js';
import type { MessageService } from '../../services/messages.js';
import {
  adminError,
  assertBranch,
  canSeeBranch,
  isAdmin,
  type AdminContext,
  type TeamMemberRow,
} from '../context.js';
import type { TeamService } from '../team/service.js';
import { inboxAlertEmail, type AlertKind } from './alerts.js';

type ConversationRow = typeof conversations.$inferSelect;

const LIST_LIMIT = 100;

export interface InboxDeps {
  db: Db;
  clients: ClientRegistry;
  messages: MessageService;
  backoffice: BackofficeService;
  /** The chat bus (customer and outbound messages), shared with the simulator. */
  chatBus: EventBus<SimEvent>;
  team: TeamService;
  mailer: Mailer;
  /** Where the dashboard lives, e.g. https://<service>/admin/ (links in alert emails). */
  dashboardUrl: string;
  /**
   * After an alert for a conversation, further customer messages within this time send no new
   * email (a customer often sends several in a row). A handoff always alerts. Default 10 minutes.
   */
  alertThrottleMs?: number;
}

const memberRef = (m: Pick<TeamMemberRow, 'id' | 'name' | 'email'>): InboxMemberRef => ({
  id: m.id,
  name: m.name,
  email: m.email,
});

export class InboxService {
  /** Inbox rows that changed, keyed by client id. */
  readonly bus = new EventBus<InboxEvent>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastAlert = new Map<string, number>();
  private readonly throttleMs: number;

  constructor(private readonly deps: InboxDeps) {
    this.throttleMs = deps.alertThrottleMs ?? 10 * 60_000;
  }

  /** Starts listening to the chat and back-office buses. Returns a stop function. */
  start(): () => void {
    const offChat = this.deps.chatBus.subscribeAll((key, event) => {
      if (event.type !== 'message' && event.type !== 'history') return;
      const message = event.type === 'message' ? event.message : undefined;
      const inbound = message?.direction === 'inbound';
      const text = message?.direction === 'inbound' ? message.text : undefined;
      this.enqueue(key, () => this.onChange(key, inbound ? { kind: 'message', text } : undefined));
    });
    const offBackoffice = this.deps.backoffice.bus.subscribeAll((key, event: BackofficeEvent) => {
      if (event.type === 'conversation') this.enqueue(key, () => this.onChange(key));
      if (event.type === 'lead') {
        const { lead } = event;
        this.enqueue(key, () =>
          this.onChange(key, lead.type === 'handoff' ? { kind: 'handoff', lead } : undefined, {
            branchId: lead.branchId,
            override: lead.type === 'handoff',
          }),
        );
      }
    });
    return () => {
      offChat();
      offBackoffice();
    };
  }

  /** Waits for every pending update and alert. For tests. */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  // ---------- Reads ----------

  async list(ctx: AdminContext, opts: { view: InboxView; branch?: string }): Promise<InboxList> {
    const filters: (SQL | undefined)[] = [this.scope(ctx)];
    if (opts.view === 'human') filters.push(eq(conversations.status, 'human'));
    if (opts.view === 'mine') {
      filters.push(eq(conversations.assignedMemberId, ctx.member.id));
      filters.push(ne(conversations.status, 'closed'));
    }
    if (opts.branch) {
      assertBranch(ctx, opts.branch);
      filters.push(eq(conversations.branchId, opts.branch));
    }
    const [rows, [count]] = await Promise.all([
      this.summaries(ctx.client, and(...filters), LIST_LIMIT),
      this.deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, ctx.client.id),
            eq(conversations.status, 'human'),
            this.scope(ctx),
          ),
        ),
    ]);
    return { conversations: rows, needsPerson: count?.n ?? 0 };
  }

  async detail(ctx: AdminContext, id: string): Promise<InboxConversationDetail> {
    const conversation = await this.visibleSummary(ctx, id);
    const [messageRows, leadRows, members] = await Promise.all([
      this.deps.db
        .select({ m: messages, by: teamMembers })
        .from(messages)
        .leftJoin(teamMembers, eq(teamMembers.id, messages.sentByMemberId))
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id)),
      this.deps.db
        .select()
        .from(leads)
        .where(and(eq(leads.clientId, ctx.client.id), eq(leads.conversationId, id)))
        .orderBy(asc(leads.createdAt)),
      this.deps.team.list(ctx.client.id),
    ]);
    return {
      conversation,
      messages: messageRows.map(({ m, by }): InboxMessage => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        text: m.text ?? '',
        at: m.createdAt.toISOString(),
        payload: m.payload as MetaSendMessage | MetaInboundMessage,
        sentBy: by ? memberRef(by) : null,
      })),
      leads: leadRows.map((r) => toBackofficeLead(ctx.client, r)),
      assignable: members
        .filter(
          (m) =>
            m.role === 'admin' ||
            (conversation.branchId !== null && m.branches.includes(conversation.branchId)),
        )
        .map(memberRef),
    };
  }

  /** The member may see this list row: its branch, or assigned to them. */
  visible(ctx: AdminContext, row: InboxConversation): boolean {
    return canSeeBranch(ctx, row.branchId) || row.assignedTo?.id === ctx.member.id;
  }

  // ---------- Actions ----------

  async markRead(ctx: AdminContext, id: string): Promise<void> {
    const row = await this.visibleRow(ctx, id);
    await this.update(row, { teamReadAt: new Date() });
  }

  /** A person takes the conversation: the agent stays silent, and it is assigned to them. */
  async takeOver(ctx: AdminContext, id: string): Promise<InboxConversation> {
    const row = await this.openRow(ctx, id);
    await this.update(row, { status: 'human', assignedMemberId: ctx.member.id });
    return this.changed(ctx, row, 'human');
  }

  async assign(ctx: AdminContext, id: string, memberId: string | null): Promise<InboxConversation> {
    const row = await this.openRow(ctx, id);
    let member: TeamMemberRow | undefined;
    if (memberId) {
      member = await this.deps.team.get(ctx.client.id, memberId);
      if (!member) throw adminError(400, 'unknown_member', 'Esse membro não faz parte da equipa.');
      if (member.role !== 'admin' && !(row.branchId && member.branches.includes(row.branchId))) {
        throw adminError(
          400,
          'member_branch',
          'Essa pessoa não trabalha com a filial desta conversa.',
        );
      }
    }
    await this.update(row, { assignedMemberId: memberId });
    const summary = await this.notify(ctx.client, row.id);
    if (member && member.id !== ctx.member.id) {
      await this.sendAlert(ctx.client, summary, { kind: 'assigned', by: ctx.member });
    }
    return summary;
  }

  /**
   * Sends a WhatsApp message as the member, through the client's channel. Replying to a
   * conversation the bot still has takes it over first, so the two never answer together.
   */
  async reply(ctx: AdminContext, id: string, text: string): Promise<InboxMessage> {
    let row = await this.openRow(ctx, id);
    const client = ctx.client;
    if (row.status !== 'human') {
      await this.update(row, {
        status: 'human',
        assignedMemberId: row.assignedMemberId ?? ctx.member.id,
      });
      this.deps.backoffice.publishStatus(client.id, await this.phoneOf(row), 'human');
      row = { ...row, status: 'human' };
    }
    const now = new Date();
    await this.update(row, { lastActivityAt: now, teamReadAt: now });
    const sent = await this.deps.messages.send(
      client,
      row.id,
      await this.phoneOf(row),
      { type: 'text', text },
      { sentByMemberId: ctx.member.id },
    );
    return {
      id: sent.id,
      direction: 'outbound',
      type: sent.type,
      text: sent.text ?? '',
      at: sent.createdAt.toISOString(),
      payload: sent.payload as MetaSendMessage,
      sentBy: memberRef(ctx.member),
    };
  }

  /** Hands the conversation back to the agent (as the simulator's WA-016 command does). */
  async returnToBot(ctx: AdminContext, id: string): Promise<InboxConversation> {
    const row = await this.openRow(ctx, id);
    await this.update(row, { status: 'bot', assignedMemberId: null });
    return this.changed(ctx, row, 'bot');
  }

  // ---------- Internals ----------

  /** Sales: their branches' conversations and those assigned to them. Admins: everything. */
  private scope(ctx: AdminContext): SQL | undefined {
    if (isAdmin(ctx)) return undefined;
    const mine = eq(conversations.assignedMemberId, ctx.member.id);
    return ctx.branchIds.length ? or(inArray(conversations.branchId, ctx.branchIds), mine) : mine;
  }

  private async row(clientId: string, id: string): Promise<ConversationRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.deps.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.clientId, clientId), eq(conversations.id, id)));
    return row;
  }

  private async visibleRow(ctx: AdminContext, id: string): Promise<ConversationRow> {
    const row = await this.row(ctx.client.id, id);
    const ok = row && (canSeeBranch(ctx, row.branchId) || row.assignedMemberId === ctx.member.id);
    if (!ok) throw adminError(404, 'not_found', 'Conversa não encontrada.');
    return row;
  }

  private async openRow(ctx: AdminContext, id: string): Promise<ConversationRow> {
    const row = await this.visibleRow(ctx, id);
    if (row.status === 'closed') {
      throw adminError(
        409,
        'closed',
        'Esta conversa já terminou. O cliente abre outra ao escrever.',
      );
    }
    return row;
  }

  private async visibleSummary(ctx: AdminContext, id: string): Promise<InboxConversation> {
    await this.visibleRow(ctx, id);
    const [summary] = await this.summaries(ctx.client, eq(conversations.id, id), 1);
    return summary!;
  }

  private async update(row: ConversationRow, set: Partial<ConversationRow>): Promise<void> {
    await this.deps.db.update(conversations).set(set).where(eq(conversations.id, row.id));
  }

  /** After a status change: tell the simulator's panel (and through it, this inbox). */
  private async changed(
    ctx: AdminContext,
    row: ConversationRow,
    status: 'bot' | 'human',
  ): Promise<InboxConversation> {
    this.deps.backoffice.publishStatus(ctx.client.id, await this.phoneOf(row), status);
    return this.notify(ctx.client, row.id);
  }

  private async phoneOf(row: ConversationRow): Promise<string> {
    const [contact] = await this.deps.db
      .select({ waId: contacts.waId })
      .from(contacts)
      .where(eq(contacts.id, row.contactId));
    return contact!.waId;
  }

  /** Publishes the conversation's current list row. */
  private async notify(client: ClientConfig, id: string): Promise<InboxConversation> {
    const [summary] = await this.summaries(client, eq(conversations.id, id), 1);
    this.bus.publish(client.id, { type: 'conversation', conversation: summary! });
    return summary!;
  }

  /** Runs bus reactions one at a time per customer, so rows are published in order. */
  private enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => console.error(`[inbox] update for ${key} failed`, error))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Something happened in a customer's chat: update their latest conversation and alert. */
  private async onChange(
    key: string,
    alert?:
      | { kind: 'message'; text?: string }
      | { kind: 'handoff'; lead: { branchId: string | null; fields: Record<string, unknown> } },
    branch?: { branchId: string | null; override: boolean },
  ): Promise<void> {
    const { clientId, phone } = EventBus.parseKey(key);
    const client = this.deps.clients.get(clientId);
    if (!client) return;
    const [latest] = await this.deps.db
      .select({ id: conversations.id, branchId: conversations.branchId })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(contacts.clientId, clientId), eq(contacts.waId, phone)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    if (!latest) return;

    // A lead tells which branch follows the conversation up; a handoff's branch wins.
    if (branch?.branchId && (branch.override || !latest.branchId)) {
      await this.deps.db
        .update(conversations)
        .set({ branchId: branch.branchId })
        .where(
          branch.override
            ? eq(conversations.id, latest.id)
            : and(eq(conversations.id, latest.id), isNull(conversations.branchId)),
        );
    }
    const summary = await this.notify(client, latest.id);

    if (alert?.kind === 'handoff') {
      await this.sendAlert(client, summary, {
        kind: 'handoff',
        branchId: alert.lead.branchId,
        summary:
          typeof alert.lead.fields['summary'] === 'string' ? alert.lead.fields['summary'] : '',
      });
    } else if (alert?.kind === 'message' && summary.status === 'human') {
      await this.sendAlert(client, summary, { kind: 'message', text: alert.text ?? '' });
    }
  }

  /** Emails the assigned member, else the branch's team (TeamService.ofBranch), else the admins. */
  private async sendAlert(
    client: ClientConfig,
    conversation: InboxConversation,
    alert: AlertKind,
  ): Promise<void> {
    const to = await this.alertRecipients(client, conversation, alert);
    if (!to.length) return; // nobody on the team yet: the agent's own handoff email still goes
    // Throttled per conversation and recipients, so a takeover alerts the new assignee at once.
    const key = `${conversation.id}:${to.join(',')}`;
    const now = Date.now();
    if (alert.kind === 'message') {
      const last = this.lastAlert.get(key);
      if (last !== undefined && now - last < this.throttleMs) return;
    }
    if (alert.kind !== 'assigned') {
      if (this.lastAlert.size > 1000) {
        for (const [k, at] of this.lastAlert)
          if (now - at >= this.throttleMs) this.lastAlert.delete(k);
      }
      this.lastAlert.set(key, now);
    }
    await this.deps.mailer.send(
      inboxAlertEmail({ client, conversation, alert, to, dashboardUrl: this.deps.dashboardUrl }),
    );
  }

  /** Who an alert goes to (exported through the email's `to` for tests and the panel). */
  async alertRecipients(
    client: ClientConfig,
    conversation: InboxConversation,
    alert: AlertKind,
  ): Promise<string[]> {
    if (conversation.assignedTo) return [conversation.assignedTo.email];
    const branchId = (alert.kind === 'handoff' && alert.branchId) || conversation.branchId;
    const ofBranch = branchId ? await this.deps.team.ofBranch(client.id, branchId) : [];
    // No branch, or nobody on it: the client's admins.
    const members = ofBranch.length
      ? ofBranch
      : (await this.deps.team.list(client.id)).filter((m) => m.role === 'admin');
    return [...new Set(members.map((m) => m.email))];
  }

  /** List rows: the conversation, its contact, assignee, last message and unread count. */
  private async summaries(
    client: ClientConfig,
    where: SQL | undefined,
    limit: number,
  ): Promise<InboxConversation[]> {
    const rows = await this.deps.db
      .select({ c: conversations, contact: contacts, assigned: teamMembers })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(teamMembers, eq(teamMembers.id, conversations.assignedMemberId))
      .where(and(eq(conversations.clientId, client.id), where))
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.createdAt))
      .limit(limit);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.c.id);

    const [last, unread] = await Promise.all([
      this.deps.db
        .selectDistinctOn([messages.conversationId], {
          conversationId: messages.conversationId,
          direction: messages.direction,
          text: messages.text,
          type: messages.type,
          createdAt: messages.createdAt,
          sentByMemberId: messages.sentByMemberId,
        })
        .from(messages)
        .where(inArray(messages.conversationId, ids))
        .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.id)),
      // Customer messages after the team last read the conversation and after the last reply.
      this.deps.db
        .select({ conversationId: messages.conversationId, n: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            inArray(messages.conversationId, ids),
            eq(messages.direction, 'inbound'),
            sql`${messages.createdAt} > coalesce(${conversations.teamReadAt}, 'epoch'::timestamptz)`,
            sql`not exists (select 1 from ${messages} as o where o.conversation_id = ${messages.conversationId} and o.direction = 'outbound' and o.created_at >= ${messages.createdAt})`,
          ),
        )
        .groupBy(messages.conversationId),
    ]);
    const lastBy = new Map(last.map((m) => [m.conversationId, m]));
    const unreadBy = new Map(unread.map((u) => [u.conversationId, u.n]));

    return rows.map(({ c, contact, assigned }): InboxConversation => {
      const m = lastBy.get(c.id);
      return {
        id: c.id,
        status: c.status,
        contact: { id: contact.id, name: contact.name, phone: contact.waId },
        branchId: c.branchId,
        branchName: client.branches.find((b) => b.id === c.branchId)?.name ?? null,
        assignedTo: assigned ? memberRef(assigned) : null,
        lastActivityAt: c.lastActivityAt.toISOString(),
        createdAt: c.createdAt.toISOString(),
        lastMessage: m
          ? {
              direction: m.direction,
              text: (m.text ?? '').trim() || `[${m.type}]`,
              at: m.createdAt.toISOString(),
              byMember: m.sentByMemberId !== null,
            }
          : null,
        unread: unreadBy.get(c.id) ?? 0,
      };
    });
  }
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
