/**
 * Customer records for the dashboard (WA-027): list and search, the record page (numbers,
 * conversations, leads and order drafts, notes, profile), edits, notes, the profile's fields and
 * locks, "clear profile" (through WA-028's PrivacyService), linking numbers.
 *
 * Who sees what: admins every record of their client; sales the records with a lead (or a
 * handoff) on one of their branches, and only those leads.
 */
import {
  isProfileField,
  type ClientConfig,
  type CustomerDetail,
  type CustomerList,
  type CustomerListItem,
  type CustomerProfileFieldView,
  type ProfileField,
  type ProfileValue,
  type SetProfileFieldBody,
} from '@wa/shared';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { customerListQuerySchema, updateCustomerSchema } from '@wa/shared';
import {
  profileRows,
  profilingState,
  ProfileValueError,
  removeField,
  setFromTeam,
} from '../../customers/profile.js';
import {
  contactIdsOfCustomer,
  ensureAllCustomers,
  ensureCustomer,
} from '../../customers/records.js';
import type { Db } from '../../db/index.js';
import {
  contacts,
  conversations,
  customerNotes,
  customerProfileFields,
  customers,
  leads,
  quotes,
  teamMembers,
} from '../../db/schema.js';
import type { PrivacyService } from '../../privacy/service.js';
import { adminError, branchFilter, isAdmin, type AdminContext } from '../context.js';

export type CustomerFilters = z.output<typeof customerListQuerySchema>;
type CustomerRow = typeof customers.$inferSelect;

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

/** conversations.id, qualified: in a single-table select drizzle leaves it bare ("id" = messages.id). */
const conversationRef = sql`${sql.identifier('conversations')}.${sql.identifier('id')}`;

/** customers.id, qualified, for the correlated subqueries below. */
const recordRef = sql`${sql.identifier('customers')}.${sql.identifier('id')}`;

const phones = sql<
  string[]
>`coalesce((select array_agg(c.wa_id order by c.created_at) from contacts c where c.customer_id = ${recordRef}), '{}')`;
const firstName = sql<
  string | null
>`(select c.name from contacts c where c.customer_id = ${recordRef} and c.name is not null order by c.created_at limit 1)`;
const lastActivity =
  sql<Date>`greatest(${customers.createdAt}, (select max(v.last_activity_at) from conversations v join contacts c on c.id = v.contact_id where c.customer_id = ${recordRef}))`.mapWith(
    (v: Date | string) => new Date(v),
  );
const conversationCount =
  sql<number>`(select count(*)::int from conversations v join contacts c on c.id = v.contact_id where c.customer_id = ${recordRef})`.mapWith(
    Number,
  );
const optedOut = sql<boolean>`exists (select 1 from contacts c where c.customer_id = ${recordRef} and c.profiling_opt_out)`;
const hasContacts = sql`exists (select 1 from contacts c where c.customer_id = ${recordRef})`;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function productsOf(fields: Record<string, unknown>): string | null {
  const items = Array.isArray(fields['items'])
    ? (fields['items'] as Record<string, unknown>[])
    : [];
  const lines = items
    .map(
      (i) =>
        [str(i['title']), str(i['variant'])].filter(Boolean).join(' ') +
        (i['quantity'] ? ` × ${String(i['quantity'])}` : ''),
    )
    .filter(Boolean);
  return str(fields['products']) ?? (lines.length ? lines.join(', ') : null);
}

export class CustomersService {
  constructor(private readonly deps: { db: Db; privacy: PrivacyService; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Leads the member may see: all for admins; their branches' for sales. */
  private leadScope(ctx: AdminContext): SQL {
    return isAdmin(ctx)
      ? sql`true`
      : ctx.branchIds.length
        ? sql`l.branch_id in (${sql.join(
            ctx.branchIds.map((b) => sql`${b}`),
            sql`, `,
          )})`
        : sql`false`;
  }

  private leadCount(ctx: AdminContext) {
    return sql<number>`(select count(*)::int from leads l join contacts c on c.id = l.contact_id where c.customer_id = ${recordRef} and ${this.leadScope(ctx)})`.mapWith(
      Number,
    );
  }

  /** Sales see a record when it has a lead on one of their branches. */
  private visible(ctx: AdminContext): SQL | undefined {
    if (isAdmin(ctx)) return undefined;
    return sql`exists (select 1 from leads l join contacts c on c.id = l.contact_id where c.customer_id = ${recordRef} and ${this.leadScope(ctx)})`;
  }

  async list(ctx: AdminContext, f: CustomerFilters): Promise<CustomerList> {
    const db = this.deps.db;
    await ensureAllCustomers(db, ctx.client.id);
    const conditions: (SQL | undefined)[] = [
      eq(customers.clientId, ctx.client.id),
      hasContacts,
      this.visible(ctx),
    ];
    if (f.role) conditions.push(eq(customers.role, f.role));
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`;
      const digits = f.q.replace(/\D/g, '');
      conditions.push(
        sql`(${customers.name} ilike ${like} or ${customers.company} ilike ${like} or ${customers.nif} ilike ${like} or exists (select 1 from contacts c where c.customer_id = ${recordRef} and (c.name ilike ${like}${digits.length >= 3 ? sql` or c.wa_id like ${`%${digits}%`}` : sql``})))`,
      );
    }
    const where = and(...conditions);
    const [rows, [total]] = await Promise.all([
      db
        .select({
          record: customers,
          phones,
          firstName,
          lastActivityAt: lastActivity,
          conversations: conversationCount,
          leads: this.leadCount(ctx),
          optedOut,
        })
        .from(customers)
        .where(where)
        .orderBy(desc(lastActivity), desc(customers.id))
        .limit(f.limit)
        .offset(f.offset),
      db
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(customers)
        .where(where),
    ]);
    return {
      items: rows.map((r): CustomerListItem => ({
        id: r.record.id,
        name: r.record.name ?? r.firstName,
        company: r.record.company,
        role: r.record.role,
        phones: r.phones,
        lastActivityAt: r.lastActivityAt.toISOString(),
        conversations: r.conversations,
        leads: r.leads,
        profiling: !ctx.client.profiling.enabled ? 'disabled' : r.optedOut ? 'opted_out' : 'on',
      })),
      total: total?.n ?? 0,
      limit: f.limit,
      offset: f.offset,
    };
  }

  /** The record, 404 when it is not this client's (or has no number), 403 when not visible. */
  private async record(ctx: AdminContext, id: string): Promise<CustomerRow> {
    const [row] = isUuid(id)
      ? await this.deps.db
          .select({ record: customers, visible: this.visible(ctx) ?? sql<boolean>`true` })
          .from(customers)
          .where(and(eq(customers.clientId, ctx.client.id), eq(customers.id, id), hasContacts))
      : [];
    if (!row) throw adminError(404, 'not_found', 'Cliente não encontrado.');
    if (!row.visible) {
      throw adminError(403, 'forbidden_branch', 'Este cliente não tem pedidos das suas filiais.');
    }
    return row.record;
  }

  async detail(ctx: AdminContext, id: string): Promise<CustomerDetail> {
    const record = await this.record(ctx, id);
    const db = this.deps.db;
    const people = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clientId, ctx.client.id), eq(contacts.customerId, record.id)))
      .orderBy(asc(contacts.createdAt));
    const contactIds = people.map((p) => p.id);
    const [convs, leadRows, quoteRows, notes, profile, state] = await Promise.all([
      db
        .select({
          conversation: conversations,
          messages:
            sql<number>`(select count(*)::int from messages m where m.conversation_id = ${conversationRef})`.mapWith(
              Number,
            ),
          lastText: sql<
            string | null
          >`(select left(m.text, 140) from messages m where m.conversation_id = ${conversationRef} and m.text is not null order by m.created_at desc limit 1)`,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, ctx.client.id),
            inArray(conversations.contactId, contactIds),
          ),
        )
        .orderBy(desc(conversations.lastActivityAt)),
      db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.clientId, ctx.client.id),
            inArray(leads.contactId, contactIds),
            branchFilter(ctx, leads.branchId),
          ),
        )
        .orderBy(desc(leads.createdAt)),
      db
        .select({
          id: quotes.id,
          number: quotes.number,
          status: quotes.status,
          leadId: quotes.leadId,
          branchId: quotes.branchId,
          totalCents: quotes.totalCents,
          validUntil: quotes.validUntil,
          createdAt: quotes.createdAt,
          sentAt: quotes.sentAt,
        })
        .from(quotes)
        .where(
          and(
            eq(quotes.clientId, ctx.client.id),
            inArray(quotes.contactId, contactIds),
            branchFilter(ctx, quotes.branchId),
          ),
        )
        .orderBy(desc(quotes.createdAt)),
      db
        .select({ note: customerNotes, author: teamMembers })
        .from(customerNotes)
        .leftJoin(teamMembers, eq(teamMembers.id, customerNotes.authorMemberId))
        .where(
          and(eq(customerNotes.clientId, ctx.client.id), eq(customerNotes.customerId, record.id)),
        )
        .orderBy(desc(customerNotes.createdAt)),
      this.profileView(ctx.client.id, record.id),
      profilingState(db, ctx.client, record.id),
    ]);
    return {
      id: record.id,
      name: record.name,
      company: record.company,
      nif: record.nif,
      role: record.role,
      regions: record.regions,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      contacts: people.map((p) => ({
        id: p.id,
        phone: p.waId,
        name: p.name,
        language: p.language,
        profilingOptOut: p.profilingOptOut,
        createdAt: p.createdAt.toISOString(),
      })),
      conversations: convs.map((c) => ({
        id: c.conversation.id,
        contactId: c.conversation.contactId,
        status: c.conversation.status,
        createdAt: c.conversation.createdAt.toISOString(),
        lastActivityAt: c.conversation.lastActivityAt.toISOString(),
        messages: c.messages,
        lastText: c.lastText,
      })),
      leads: leadRows.map((l) => {
        const fields = l.fields as Record<string, unknown>;
        return {
          id: l.id,
          type: l.type,
          status: l.status,
          branchId: l.branchId,
          branchName: ctx.client.branches.find((b) => b.id === l.branchId)?.name ?? null,
          createdAt: l.createdAt.toISOString(),
          products: productsOf(fields),
          summary: str(fields['summary']),
        };
      }),
      quotes: quoteRows.map((q) => ({
        id: q.id,
        number: q.number,
        status: q.status,
        leadId: q.leadId,
        branchName: ctx.client.branches.find((b) => b.id === q.branchId)?.name ?? null,
        totalCents: q.totalCents,
        validUntil: q.validUntil,
        createdAt: q.createdAt.toISOString(),
        sentAt: q.sentAt?.toISOString() ?? null,
      })),
      notes: notes.map(({ note, author }) => ({
        id: note.id,
        body: note.body,
        author: author ? { id: author.id, name: author.name, email: author.email } : null,
        createdAt: note.createdAt.toISOString(),
      })),
      // With profiling off nothing is shown or used; "clear profile" has already removed it.
      profile: { state, fields: state === 'on' ? profile : [] },
    };
  }

  private async profileView(clientId: string, customerId: string) {
    const rows = await profileRows(this.deps.db, clientId, customerId);
    const editors = rows.flatMap((r) => (r.updatedBy ? [r.updatedBy] : []));
    const members = editors.length
      ? await this.deps.db.select().from(teamMembers).where(inArray(teamMembers.id, editors))
      : [];
    return rows.map((r): CustomerProfileFieldView => {
      const m = members.find((x) => x.id === r.updatedBy);
      return {
        field: r.field as ProfileField,
        value: r.value as ProfileValue | null,
        source: r.source,
        locked: r.locked,
        evidence: r.evidence,
        conversationId: r.conversationId,
        updatedAt: r.updatedAt.toISOString(),
        updatedBy: m ? (m.name ?? m.email) : null,
      };
    });
  }

  /** The record of a WhatsApp contact (for the inbox, WA-023), created if needed. */
  async byContact(ctx: AdminContext, contactId: string): Promise<CustomerDetail> {
    const id = isUuid(contactId)
      ? await ensureCustomer(this.deps.db, ctx.client.id, contactId)
      : undefined;
    if (!id) throw adminError(404, 'not_found', 'Cliente não encontrado.');
    return this.detail(ctx, id);
  }

  async update(ctx: AdminContext, id: string, body: z.output<typeof updateCustomerSchema>) {
    const record = await this.record(ctx, id);
    await this.deps.db
      .update(customers)
      .set({ ...body, updatedAt: this.now() })
      .where(eq(customers.id, record.id));
    return this.detail(ctx, record.id);
  }

  async addNote(ctx: AdminContext, id: string, body: string) {
    const record = await this.record(ctx, id);
    await this.deps.db.insert(customerNotes).values({
      clientId: ctx.client.id,
      customerId: record.id,
      authorMemberId: ctx.member.id,
      body,
    });
    return this.detail(ctx, record.id);
  }

  private async profileOn(ctx: AdminContext, record: CustomerRow) {
    const state = await profilingState(this.deps.db, ctx.client, record.id);
    if (state === 'disabled') {
      throw adminError(
        409,
        'profiling_disabled',
        'As preferências de clientes estão desligadas para esta empresa.',
      );
    }
    if (state === 'opted_out') {
      throw adminError(
        409,
        'profiling_opted_out',
        'Este cliente opôs-se à criação de um perfil: as preferências não são guardadas.',
      );
    }
  }

  async setProfileField(ctx: AdminContext, id: string, field: string, body: SetProfileFieldBody) {
    const record = await this.record(ctx, id);
    if (!isProfileField(field)) throw adminError(404, 'unknown_field', 'Campo desconhecido.');
    await this.profileOn(ctx, record);
    if (body.value === undefined && body.locked === undefined) {
      throw adminError(400, 'invalid_body', 'Indique um valor ou se o campo fica bloqueado.');
    }
    try {
      await setFromTeam(this.deps.db, {
        clientId: ctx.client.id,
        customerId: record.id,
        field,
        value: body.value === null ? undefined : body.value,
        locked: body.locked,
        memberId: ctx.member.id,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof ProfileValueError) {
        throw adminError(400, 'invalid_value', `Valor não aceite: ${error.message}`);
      }
      throw error;
    }
    return this.detail(ctx, record.id);
  }

  async removeProfileField(ctx: AdminContext, id: string, field: string) {
    const record = await this.record(ctx, id);
    if (!isProfileField(field)) throw adminError(404, 'unknown_field', 'Campo desconhecido.');
    await removeField(this.deps.db, record.id, field);
    return this.detail(ctx, record.id);
  }

  /**
   * "Clear profile" (WA-028): removes the profile of every number of the record and stops
   * profiling the customer; audited. History stays.
   */
  async clearProfile(ctx: AdminContext, id: string) {
    const record = await this.record(ctx, id);
    const [first] = await contactIdsOfCustomer(this.deps.db, ctx.client.id, record.id);
    if (!first) throw adminError(404, 'not_found', 'Cliente não encontrado.');
    await this.deps.privacy.clearProfile(ctx.client, first, ctx.member);
    return this.detail(ctx, record.id);
  }

  /**
   * Links a WhatsApp number to the record. A number that has not written yet becomes a contact;
   * a number of another record moves here, and that record, left without numbers, is merged in
   * (notes, missing record fields and profile fields). If a number objected to profiling, the
   * merged record's profile is removed.
   */
  async linkContact(ctx: AdminContext, id: string, phone: string) {
    const record = await this.record(ctx, id);
    const db = this.deps.db;
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [existing] = await t
        .select()
        .from(contacts)
        .where(and(eq(contacts.clientId, ctx.client.id), eq(contacts.waId, phone)));
      const contact =
        existing ??
        (await t.insert(contacts).values({ clientId: ctx.client.id, waId: phone }).returning())[0]!;
      if (contact.customerId === record.id) return;
      const from = contact.customerId;
      await t.update(contacts).set({ customerId: record.id }).where(eq(contacts.id, contact.id));
      if (from) await this.mergeIfEmpty(t, ctx.client, from, record);
      if (contact.profilingOptOut) {
        await t
          .delete(customerProfileFields)
          .where(eq(customerProfileFields.customerId, record.id));
      }
      await t.update(customers).set({ updatedAt: this.now() }).where(eq(customers.id, record.id));
    });
    return this.detail(ctx, record.id);
  }

  private async mergeIfEmpty(db: Db, client: ClientConfig, fromId: string, into: CustomerRow) {
    const left = await contactIdsOfCustomer(db, client.id, fromId);
    if (left.length) return;
    const [from] = await db.select().from(customers).where(eq(customers.id, fromId));
    if (!from) return;
    await db
      .update(customerNotes)
      .set({ customerId: into.id })
      .where(eq(customerNotes.customerId, fromId));
    const mine = new Set((await profileRows(db, client.id, into.id)).map((r) => r.field));
    const theirs = await profileRows(db, client.id, fromId);
    for (const r of theirs) {
      if (mine.has(r.field)) continue;
      await db
        .update(customerProfileFields)
        .set({ customerId: into.id })
        .where(eq(customerProfileFields.id, r.id));
    }
    await db
      .update(customers)
      .set({
        name: into.name ?? from.name,
        company: into.company ?? from.company,
        nif: into.nif ?? from.nif,
        role: into.role ?? from.role,
        regions: into.regions.length ? into.regions : from.regions,
      })
      .where(eq(customers.id, into.id));
    await db.delete(customers).where(eq(customers.id, fromId));
  }

  /** Takes a number off the record; it gets a record of its own. The last number stays. */
  async unlinkContact(ctx: AdminContext, id: string, contactId: string) {
    const record = await this.record(ctx, id);
    const ids = await contactIdsOfCustomer(this.deps.db, ctx.client.id, record.id);
    if (!ids.includes(contactId)) throw adminError(404, 'not_found', 'Número não encontrado.');
    if (ids.length === 1) {
      throw adminError(409, 'last_contact', 'O cliente tem de ficar com pelo menos um número.');
    }
    await this.deps.db
      .update(contacts)
      .set({ customerId: null })
      .where(and(eq(contacts.clientId, ctx.client.id), eq(contacts.id, contactId)));
    await ensureCustomer(this.deps.db, ctx.client.id, contactId);
    return this.detail(ctx, record.id);
  }
}
