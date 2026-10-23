/**
 * Privacy tools (WA-028): export, clear profile and delete a customer, privacy requests from
 * WhatsApp, the retention job and the audit log. All data access goes through the registered
 * PersonalDataHandlers (registry.ts), so new tables only need a handler.
 */
import { createHash } from 'node:crypto';
import {
  confirmsCustomer,
  phoneDigits,
  type ClientConfig,
  type PrivacyAuditAction,
  type PrivacyAuditEntry,
  type PrivacyCounts,
  type PrivacyCustomer,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
  type PrivacyRequestView,
  type PrivacyRetentionView,
} from '@wa/shared';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  contacts,
  conversations,
  leads,
  privacyAudit,
  privacyRequests,
  teamMembers,
} from '../db/schema.js';
import type { MessageService } from '../services/messages.js';
import { personalDataHandlers } from './handlers.js';
import type { PersonalDataHandler, PrivacyContext } from './registry.js';
import { openPrivacyRequest, type PrivacyRequestRow } from './requests.js';
import { zipStream, type ZipEntry } from './zip.js';

type TeamMemberRow = typeof teamMembers.$inferSelect;
type ContactRow = typeof contacts.$inferSelect;

/**
 * Who "the customer" is. Today a customer is one WhatsApp contact; WA-027 groups contacts into a
 * customer record and passes a resolver that returns all of that record's contacts, so export,
 * clear profile and delete cover every number of the person. The API stays keyed by contact id.
 */
export interface SubjectResolver {
  contactIds(db: Db, clientId: string, contactId: string): Promise<string[]>;
}

export const contactSubject: SubjectResolver = {
  async contactIds(db, clientId, contactId) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.clientId, clientId), eq(contacts.id, contactId)));
    return row ? [row.id] : [];
  },
};

/** An expected failure; the message is pt-PT for the dashboard. */
export class PrivacyError extends Error {
  constructor(
    readonly code: 'not_found' | 'confirm_mismatch' | 'not_pending' | 'customer_gone',
    message: string,
  ) {
    super(message);
    this.name = 'PrivacyError';
  }
}

/** How long before the retention job deletes someone the admins see them listed. */
export const RETENTION_NOTICE_DAYS = 7;

/** A hash of the contact id for the audit log: matches entries without naming the person. */
export const targetHash = (contactId: string) =>
  createHash('sha256').update(contactId).digest('hex');

const messagesTo = {
  delete: {
    pt: 'Os seus dados foram apagados, como pediu. Se voltar a escrever-nos, começamos uma conversa nova.',
    en: 'Your data has been deleted, as you asked. If you write to us again, we will start a new conversation.',
  },
  clear_profile: {
    pt: 'Feito: apagámos as preferências que tínhamos guardado sobre si e deixámos de as usar para personalizar as respostas. O seu histórico mantém-se.',
    en: 'Done: we deleted the preferences we had stored about you and no longer use them to personalise our replies. Your history is kept.',
  },
  export: {
    pt: 'Preparámos a cópia dos seus dados que pediu. Um colega vai combinar consigo como lha enviar.',
    en: 'We have prepared the copy of your data you asked for. A colleague will arrange with you how to send it.',
  },
  rejected: {
    pt: 'Sobre o seu pedido relativo aos seus dados: um colega vai contactá-lo para o esclarecer.',
    en: 'About your request regarding your data: a colleague will contact you to clarify it.',
  },
} as const;

export class PrivacyService {
  private readonly handlers: PersonalDataHandler[];
  private readonly subjects: SubjectResolver;

  constructor(
    private readonly deps: {
      db: Db;
      messages: MessageService;
      handlers?: PersonalDataHandler[];
      subjects?: SubjectResolver;
      now?: () => Date;
    },
  ) {
    this.handlers = [...(deps.handlers ?? personalDataHandlers)];
    this.subjects = deps.subjects ?? contactSubject;
  }

  /** Adds a handler at runtime (e.g. WA-027's profile store, built in createApp). */
  registerPersonalData(handler: PersonalDataHandler): void {
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`Personal data handler "${handler.name}" is already registered`);
    }
    this.handlers.push(handler);
  }

  registeredHandlers(): readonly PersonalDataHandler[] {
    return this.handlers;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ---------- Customers ----------

  /** By phone (digits) or name; the most recently active first. Empty query: the latest. */
  async findCustomers(clientId: string, query: string, limit = 20): Promise<PrivacyCustomer[]> {
    const q = query.trim();
    let match: SQL | undefined;
    if (q && /^[+\d\s().-]+$/.test(q) && phoneDigits(q).length >= 3) {
      match = ilike(contacts.waId, `%${phoneDigits(q)}%`);
    } else if (q) {
      match = ilike(contacts.name, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = await this.customerQuery(and(eq(contacts.clientId, clientId), match))
      .orderBy(desc(lastActivity))
      .limit(limit);
    return rows.map(toCustomer);
  }

  async customer(clientId: string, contactId: string): Promise<PrivacyCustomer | undefined> {
    const [row] = await this.customerQuery(
      and(eq(contacts.clientId, clientId), eq(contacts.id, contactId)),
    );
    return row && toCustomer(row);
  }

  private customerQuery(where: SQL | undefined) {
    return this.deps.db
      .select({
        contact: contacts,
        lastActivityAt: lastActivity,
        conversations:
          sql<number>`(select count(*)::int from ${conversations} where ${conversations.contactId} = ${contactRef})`.mapWith(
            Number,
          ),
        leads:
          sql<number>`(select count(*)::int from ${leads} where ${leads.contactId} = ${contactRef})`.mapWith(
            Number,
          ),
        pendingRequests:
          sql<number>`(select count(*)::int from ${privacyRequests} where ${privacyRequests.contactId} = ${contactRef} and ${privacyRequests.status} = 'pending')`.mapWith(
            Number,
          ),
      })
      .from(contacts)
      .where(where)
      .$dynamic();
  }

  private async subject(clientId: string, contactId: string): Promise<string[]> {
    const ids = await this.subjects.contactIds(this.deps.db, clientId, contactId);
    if (ids.length === 0) throw new PrivacyError('not_found', 'Cliente não encontrado.');
    return ids;
  }

  private async context(db: Db, client: ClientConfig, contactIds: string[]) {
    const people = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clientId, client.id), inArray(contacts.id, contactIds)));
    const convs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.contactId, contactIds));
    const conversationIds = convs.map((c) => c.id);
    const leadPeople = await db
      .select({
        name: sql<string | null>`${leads.fields}->>'name'`,
        email: sql<string | null>`${leads.fields}->>'email'`,
      })
      .from(leads)
      .where(
        and(
          eq(leads.clientId, client.id),
          or(inArray(leads.contactId, contactIds), inArray(leads.conversationId, conversationIds)),
        ),
      );
    const uniq = (xs: (string | null | undefined)[]) => [
      ...new Set(xs.map((x) => x?.trim()).filter((x): x is string => Boolean(x))),
    ];
    const ctx: PrivacyContext = {
      db,
      client,
      now: this.now(),
      contactIds,
      conversationIds,
      identifiers: {
        phones: uniq(people.map((p) => p.waId)),
        names: uniq([...people.map((p) => p.name), ...leadPeople.map((l) => l.name)]),
        emails: uniq(leadPeople.map((l) => l.email?.toLowerCase())),
      },
    };
    return { ctx, people };
  }

  private sorted(): PersonalDataHandler[] {
    return [...this.handlers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // ---------- Export ----------

  /** Every handler's export, as data.json holds it, plus the files for the ZIP. */
  async collect(client: ClientConfig, contactId: string) {
    const contactIds = await this.subject(client.id, contactId);
    const { ctx } = await this.context(this.deps.db, client, contactIds);
    const data: Record<string, unknown> = {};
    const files: ZipEntry[] = [];
    const counts: PrivacyCounts = {};
    for (const handler of this.handlers) {
      const out = await handler.export(ctx);
      data[handler.name] = out.data;
      counts[handler.name] = Array.isArray(out.data) ? out.data.length : 1;
      for (const file of out.files ?? []) {
        files.push({ path: `media/${handler.name}/${file.path}`, data: () => file.read() });
      }
    }
    return {
      contactIds,
      counts,
      files,
      document: {
        format: 'whatsapp-agent/privacy-export@1',
        exportedAt: ctx.now.toISOString(),
        client: { id: client.id, name: client.name },
        contactIds,
        data,
      },
    };
  }

  /** The ZIP (data.json and media/), streamed. The export is audited before it starts. */
  async exportZip(client: ClientConfig, contactId: string, actor: TeamMemberRow) {
    const { document, files, counts } = await this.collect(client, contactId);
    await this.audit(this.deps.db, client.id, actor, 'export', contactId, counts);
    const json = new TextEncoder().encode(JSON.stringify(document, null, 2));
    const stream = zipStream([{ path: 'data.json', data: async () => json }, ...files]);
    const date = document.exportedAt.slice(0, 10);
    return { stream, filename: `dados-cliente-${date}.zip` };
  }

  // ---------- Clear profile ----------

  /**
   * Removes what profiling built (WA-027's handler) and sets `profiling_opt_out`, which WA-027
   * honours from then on. Messages, leads and the rest of the history stay.
   */
  async clearProfile(
    client: ClientConfig,
    contactId: string,
    actor: TeamMemberRow,
    requestId?: string,
  ): Promise<PrivacyCounts> {
    const contactIds = await this.subject(client.id, contactId);
    return this.deps.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const { ctx } = await this.context(db, client, contactIds);
      const counts: PrivacyCounts = {};
      for (const handler of this.handlers) {
        if (handler.clearProfile) counts[handler.name] = await handler.clearProfile(ctx);
      }
      await db
        .update(contacts)
        .set({ profilingOptOut: true })
        .where(and(eq(contacts.clientId, client.id), inArray(contacts.id, contactIds)));
      await this.audit(db, client.id, actor, 'clear_profile', contactId, counts, requestId);
      if (requestId) await this.finish(db, requestId, 'done', actor, counts);
      return counts;
    });
  }

  // ---------- Delete ----------

  /**
   * Deletes the customer: every handler's erase, in one transaction (all or nothing). With
   * `confirm`, it must be the customer's name or number.
   */
  async deleteCustomer(
    client: ClientConfig,
    contactId: string,
    opts: {
      actor: TeamMemberRow | null;
      confirm?: string;
      requestId?: string;
      action?: Extract<PrivacyAuditAction, 'delete' | 'retention_delete'>;
    },
  ): Promise<{ counts: PrivacyCounts; people: ContactRow[] }> {
    const contactIds = await this.subject(client.id, contactId);
    return this.deps.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const { ctx, people } = await this.context(db, client, contactIds);
      if (opts.confirm !== undefined) {
        const ok = people.some((p) =>
          confirmsCustomer(opts.confirm!, { name: p.name, phone: p.waId }),
        );
        if (!ok) {
          throw new PrivacyError(
            'confirm_mismatch',
            'Escreva o nome ou o número do cliente exatamente como aparece, para confirmar.',
          );
        }
      }
      const counts: PrivacyCounts = {};
      for (const handler of this.sorted()) {
        const result = await handler.erase(ctx);
        if (result.deleted !== undefined) counts[handler.name] = result.deleted;
        if (result.anonymised !== undefined) {
          counts[`${handler.name}_anonymised`] = result.anonymised;
        }
      }
      const action = opts.action ?? 'delete';
      await this.audit(db, client.id, opts.actor, action, contactId, counts, opts.requestId);
      if (opts.requestId) await this.finish(db, opts.requestId, 'done', opts.actor, counts);
      return { counts, people };
    });
  }

  // ---------- Requests ----------

  openRequest(clientId: string, contactId: string, type: PrivacyRequestType) {
    return openPrivacyRequest(this.deps.db, { clientId, contactId, type, source: 'dashboard' });
  }

  async listRequests(
    clientId: string,
    status?: PrivacyRequestStatus,
    limit = 100,
  ): Promise<PrivacyRequestView[]> {
    const rows = await this.deps.db
      .select({ request: privacyRequests, contact: contacts, decider: teamMembers })
      .from(privacyRequests)
      .leftJoin(contacts, eq(contacts.id, privacyRequests.contactId))
      .leftJoin(teamMembers, eq(teamMembers.id, privacyRequests.decidedBy))
      .where(
        and(
          eq(privacyRequests.clientId, clientId),
          status ? eq(privacyRequests.status, status) : undefined,
        ),
      )
      .orderBy(desc(privacyRequests.createdAt))
      .limit(limit);
    return rows.map(({ request, contact, decider }) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      source: request.source,
      customer: contact ? { contactId: contact.id, name: contact.name, phone: contact.waId } : null,
      createdAt: request.createdAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
      decidedBy: decider ? (decider.name ?? decider.email) : null,
      result: request.result ?? null,
    }));
  }

  private async pendingRequest(clientId: string, id: string): Promise<PrivacyRequestRow> {
    const [row] = await this.deps.db
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.clientId, clientId), eq(privacyRequests.id, id)));
    if (!row) throw new PrivacyError('not_found', 'Pedido não encontrado.');
    if (row.status !== 'pending') {
      throw new PrivacyError('not_pending', 'Este pedido já foi tratado.');
    }
    if (!row.contactId) throw new PrivacyError('customer_gone', 'O cliente já foi apagado.');
    return row;
  }

  /**
   * Carries out a pending request and tells the customer on WhatsApp. A delete request needs the
   * customer's name or number in `confirm`. An export request is marked done; the admin
   * downloads the ZIP from the customer's screen.
   */
  async approveRequest(
    client: ClientConfig,
    id: string,
    actor: TeamMemberRow,
    confirm?: string,
  ): Promise<{ counts: PrivacyCounts; notified: boolean }> {
    const request = await this.pendingRequest(client.id, id);
    const contactId = request.contactId!;
    const [contact] = await this.deps.db.select().from(contacts).where(eq(contacts.id, contactId));
    const lang = contact?.language === 'en' ? 'en' : 'pt';
    switch (request.type) {
      case 'delete': {
        const { counts, people } = await this.deleteCustomer(client, contactId, {
          actor,
          confirm: confirm ?? '',
          requestId: id,
        });
        // The conversation is gone: send through the channel without storing the message.
        let notified = false;
        for (const p of people) {
          notified = (await this.notify(client, p, messagesTo.delete[lang], false)) || notified;
        }
        return { counts, notified };
      }
      case 'clear_profile': {
        const counts = await this.clearProfile(client, contactId, actor, id);
        const notified = contact
          ? await this.notify(client, contact, messagesTo.clear_profile[lang], true)
          : false;
        return { counts, notified };
      }
      case 'export': {
        await this.finish(this.deps.db, id, 'done', actor, {});
        const notified = contact
          ? await this.notify(client, contact, messagesTo.export[lang], true)
          : false;
        return { counts: {}, notified };
      }
    }
  }

  async rejectRequest(
    client: ClientConfig,
    id: string,
    actor: TeamMemberRow,
  ): Promise<{ notified: boolean }> {
    const request = await this.pendingRequest(client.id, id);
    await this.finish(this.deps.db, id, 'rejected', actor, null);
    await this.audit(
      this.deps.db,
      client.id,
      actor,
      'request_rejected',
      request.contactId!,
      {},
      id,
    );
    const [contact] = await this.deps.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, request.contactId!));
    const lang = contact?.language === 'en' ? 'en' : 'pt';
    const notified = contact
      ? await this.notify(client, contact, messagesTo.rejected[lang], true)
      : false;
    return { notified };
  }

  private async finish(
    db: Db,
    id: string,
    status: PrivacyRequestStatus,
    actor: TeamMemberRow | null,
    result: PrivacyCounts | null,
  ) {
    await db
      .update(privacyRequests)
      .set({ status, decidedBy: actor?.id ?? null, decidedAt: this.now(), result })
      .where(eq(privacyRequests.id, id));
  }

  /** Tells the customer on WhatsApp. `store`: keep it in their conversation's history. */
  private async notify(
    client: ClientConfig,
    contact: ContactRow,
    text: string,
    store: boolean,
  ): Promise<boolean> {
    try {
      if (store) {
        const conversation = await this.deps.messages.openConversation(client.id, contact.id);
        await this.deps.messages.send(client, conversation.id, contact.waId, {
          type: 'text',
          text,
        });
      } else {
        await this.deps.messages.sendWithoutHistory(client, contact.waId, { type: 'text', text });
      }
      return true;
    } catch (error) {
      console.error(`[privacy] could not notify a customer of client ${client.id}`, error);
      return false;
    }
  }

  // ---------- Retention ----------

  /** Contacts last active before this date are past the client's retention period. */
  retentionCutoff(client: ClientConfig, at: Date): Date {
    const cutoff = new Date(at);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - client.privacy.retention_months);
    return cutoff;
  }

  /** Whom the retention job deletes within `days` (or on its next run, if already due). */
  async retentionDue(
    client: ClientConfig,
    days = RETENTION_NOTICE_DAYS,
  ): Promise<PrivacyRetentionView> {
    const soon = new Date(this.now().getTime() + days * 86_400_000);
    const rows = await this.customerQuery(
      and(eq(contacts.clientId, client.id), activeBefore(this.retentionCutoff(client, soon))),
    )
      .orderBy(asc(lastActivity))
      .limit(500);
    return {
      months: client.privacy.retention_months,
      days,
      due: rows.map((r) => {
        const deleteOn = new Date(r.lastActivityAt);
        deleteOn.setUTCMonth(deleteOn.getUTCMonth() + client.privacy.retention_months);
        return { ...toCustomer(r), deleteOn: deleteOn.toISOString() };
      }),
    };
  }

  /** The scheduled job: deletes every contact past the retention period, one at a time. */
  async runRetention(client: ClientConfig, max = 500): Promise<{ deleted: number }> {
    const expired = await this.deps.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.clientId, client.id),
          activeBefore(this.retentionCutoff(client, this.now())),
        ),
      )
      .limit(max);
    let deleted = 0;
    for (const { id } of expired) {
      await this.deleteCustomer(client, id, { actor: null, action: 'retention_delete' });
      deleted++;
    }
    return { deleted };
  }

  // ---------- Audit ----------

  private async audit(
    db: Db,
    clientId: string,
    actor: TeamMemberRow | null,
    action: PrivacyAuditAction,
    contactId: string,
    counts: PrivacyCounts,
    requestId?: string,
  ) {
    await db.insert(privacyAudit).values({
      clientId,
      actorMemberId: actor?.id ?? null,
      action,
      targetHash: targetHash(contactId),
      requestId: requestId ?? null,
      counts,
    });
  }

  async auditLog(clientId: string, limit = 100): Promise<PrivacyAuditEntry[]> {
    const rows = await this.deps.db
      .select({ entry: privacyAudit, actor: teamMembers })
      .from(privacyAudit)
      .leftJoin(teamMembers, eq(teamMembers.id, privacyAudit.actorMemberId))
      .where(eq(privacyAudit.clientId, clientId))
      .orderBy(desc(privacyAudit.createdAt))
      .limit(limit);
    return rows.map(({ entry, actor }) => ({
      id: entry.id,
      action: entry.action,
      actor: actor ? (actor.name ?? actor.email) : null,
      targetHash: entry.targetHash,
      requestId: entry.requestId,
      counts: entry.counts,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

/**
 * contacts.id, qualified: drizzle leaves columns unqualified in a single-table select, and inside
 * a subquery on conversations a bare "id" would mean conversations.id.
 */
const contactRef = sql`${sql.identifier('contacts')}.${sql.identifier('id')}`;

/** The contact's last activity: its latest conversation, or when it was created. */
const lastActivity =
  sql<Date>`greatest(${contacts.createdAt}, (select max(${conversations.lastActivityAt}) from ${conversations} where ${conversations.contactId} = ${contactRef}))`.mapWith(
    (v: Date | string) => new Date(v),
  );

const activeBefore = (date: Date) => sql`${lastActivity} < ${date.toISOString()}::timestamptz`;

function toCustomer(row: {
  contact: ContactRow;
  lastActivityAt: Date;
  conversations: number;
  leads: number;
  pendingRequests: number;
}): PrivacyCustomer {
  return {
    contactId: row.contact.id,
    name: row.contact.name,
    phone: row.contact.waId,
    createdAt: row.contact.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    conversations: row.conversations,
    leads: row.leads,
    profilingOptOut: row.contact.profilingOptOut,
    pendingRequests: row.pendingRequests,
  };
}
