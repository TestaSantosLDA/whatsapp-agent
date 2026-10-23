/**
 * The leads pipeline (WA-024): list and search, the lead page, status, owner and notes, CSV.
 * Every change is recorded in `lead_events`, with who made it.
 */
import {
  leadListQuerySchema,
  leadStatusLabels,
  leadTypeLabel,
  lostReasonLabels,
  type AdminLeadAttachment,
  type AdminLeadDetail,
  type AdminLeadEvent,
  type AdminLeadList,
  type AdminLeadListItem,
  type AdminLeadNote,
  type AdminLeadPerson,
  type ClientConfig,
  type LeadEventKind,
  type LeadStatus,
  type LostReason,
  type UpdateLeadStatusBody,
} from '@wa/shared';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { workingHoursBetween } from '../../agent/hours.js';
import type { Db } from '../../db/index.js';
import { responseHours } from '../../leads/reminders.js';
import { contacts, leadEvents, leadNotes, leads, teamMembers } from '../../db/schema.js';
import type { BackofficeService } from '../../services/backoffice.js';
import {
  adminError,
  assertBranch,
  branchFilter,
  type AdminContext,
  type TeamMemberRow,
} from '../context.js';
import type { TeamService } from '../team/service.js';
import { csvDate, csvPhone, toCsv } from './csv.js';

export type LeadRow = typeof leads.$inferSelect;
export type LeadFilters = z.output<typeof leadListQuerySchema>;

const EXPORT_LIMIT = 5000;

const actors = alias(teamMembers, 'actors');

const person = (row: {
  id: string | null;
  name: string | null;
  email: string | null;
}): AdminLeadPerson | null =>
  row.id ? { id: row.id, name: row.name, email: row.email ?? '' } : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Products as the agent noted them, or the lines of an order draft. */
function productsOf(fields: Record<string, unknown>): string | null {
  const items = Array.isArray(fields['items'])
    ? (fields['items'] as Record<string, unknown>[])
    : [];
  const lines = items
    .map((i) => [str(i['title']), str(i['variant'])].filter(Boolean).join(' '))
    .filter(Boolean);
  return str(fields['products']) ?? (lines.length ? lines.join(', ') : null);
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

type ListRow = {
  lead: LeadRow;
  contactName: string | null;
  waId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
};

export class LeadsService {
  constructor(
    private readonly deps: {
      db: Db;
      team: TeamService;
      backoffice?: BackofficeService;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private where(ctx: AdminContext, f: LeadFilters): SQL | undefined {
    const conditions: (SQL | undefined)[] = [
      eq(leads.clientId, ctx.client.id),
      branchFilter(ctx, leads.branchId),
    ];
    if (f.branch.length) conditions.push(inArray(leads.branchId, f.branch));
    if (f.type.length) conditions.push(inArray(leads.type, f.type));
    if (f.status.length) conditions.push(inArray(leads.status, f.status));
    if (f.owner === 'none') conditions.push(isNull(leads.ownerMemberId));
    else if (f.owner === 'me') conditions.push(eq(leads.ownerMemberId, ctx.member.id));
    else if (f.owner) {
      if (!isUuid(f.owner)) throw adminError(400, 'invalid_owner', 'Responsável desconhecido.');
      conditions.push(eq(leads.ownerMemberId, f.owner));
    }
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`;
      const digits = f.q.replace(/\D/g, '');
      const search: SQL[] = [
        ilike(sql`coalesce(${leads.fields}->>'name', '')`, like),
        ilike(sql`coalesce(${contacts.name}, '')`, like),
        ilike(sql`coalesce(${leads.fields}->>'products', '')`, like),
        ilike(sql`coalesce(${leads.fields}->'items', '[]'::jsonb)::text`, like),
        ilike(sql`coalesce(${leads.fields}->>'summary', '')`, like),
      ];
      if (digits.length >= 3) {
        search.push(
          ilike(sql`coalesce(${contacts.waId}, '')`, `%${digits}%`),
          ilike(
            sql`regexp_replace(coalesce(${leads.fields}->>'phone', ''), '\\D', '', 'g')`,
            `%${digits}%`,
          ),
        );
      }
      conditions.push(or(...search));
    }
    return and(...conditions);
  }

  private select() {
    return this.deps.db
      .select({
        lead: leads,
        contactName: contacts.name,
        waId: contacts.waId,
        ownerId: teamMembers.id,
        ownerName: teamMembers.name,
        ownerEmail: teamMembers.email,
      })
      .from(leads)
      .leftJoin(contacts, eq(contacts.id, leads.contactId))
      .leftJoin(teamMembers, eq(teamMembers.id, leads.ownerMemberId));
  }

  async list(ctx: AdminContext, filters: LeadFilters): Promise<AdminLeadList> {
    const where = this.where(ctx, filters);
    const [rows, [total]] = await Promise.all([
      this.select()
        .where(where)
        .orderBy(desc(leads.createdAt), desc(leads.id))
        .limit(filters.limit)
        .offset(filters.offset),
      this.deps.db
        .select({ n: count() })
        .from(leads)
        .leftJoin(contacts, eq(contacts.id, leads.contactId))
        .where(where),
    ]);
    const now = this.now();
    return {
      items: rows.map((r) => this.toItem(ctx.client, r, now)),
      total: total?.n ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  private toItem(client: ClientConfig, r: ListRow, now: Date): AdminLeadListItem {
    const fields = r.lead.fields as Record<string, unknown>;
    const branch = client.branches.find((b) => b.id === r.lead.branchId);
    const waitingHours =
      r.lead.status === 'new' && branch
        ? round1(workingHoursBetween(branch, r.lead.createdAt, now, client.timezone))
        : null;
    return {
      id: r.lead.id,
      createdAt: r.lead.createdAt.toISOString(),
      type: r.lead.type,
      branchId: r.lead.branchId,
      branchName: branch?.name ?? null,
      status: r.lead.status,
      lostReason: (r.lead.lostReason as LostReason | null) ?? null,
      owner: person({ id: r.ownerId, name: r.ownerName, email: r.ownerEmail }),
      name: str(fields['name']) ?? r.contactName,
      phone: str(fields['phone']) ?? (r.waId ? `+${r.waId}` : null),
      summary: str(fields['summary']),
      products: productsOf(fields),
      conversationId: r.lead.conversationId,
      waitingHours,
      overdue: waitingHours !== null && waitingHours >= responseHours(client),
    };
  }

  /** The lead row, 404 when it is not this client's, 403 when not on the member's branches. */
  private async row(ctx: AdminContext, id: string): Promise<ListRow> {
    const [row] = isUuid(id)
      ? await this.select().where(and(eq(leads.clientId, ctx.client.id), eq(leads.id, id)))
      : [];
    if (!row) throw adminError(404, 'not_found', 'Pedido não encontrado.');
    assertBranch(ctx, row.lead.branchId);
    return row;
  }

  async detail(ctx: AdminContext, id: string): Promise<AdminLeadDetail> {
    const r = await this.row(ctx, id);
    const db = this.deps.db;
    const [notes, events, team] = await Promise.all([
      db
        .select({ note: leadNotes, id: actors.id, name: actors.name, email: actors.email })
        .from(leadNotes)
        .leftJoin(actors, eq(actors.id, leadNotes.authorMemberId))
        .where(eq(leadNotes.leadId, r.lead.id))
        .orderBy(asc(leadNotes.createdAt)),
      db
        .select({ event: leadEvents, id: actors.id, name: actors.name, email: actors.email })
        .from(leadEvents)
        .leftJoin(actors, eq(actors.id, leadEvents.actorMemberId))
        .where(eq(leadEvents.leadId, r.lead.id))
        .orderBy(desc(leadEvents.createdAt), desc(leadEvents.id)),
      this.deps.team.list(ctx.client.id),
    ]);
    const fields = r.lead.fields as Record<string, unknown>;
    const attachments = (Array.isArray(fields['attachments']) ? fields['attachments'] : []).map(
      (a: Record<string, unknown>): AdminLeadAttachment => ({
        type: str(a['type']) ?? 'document',
        messageId: str(a['message_id']),
        mediaId: str(a['media_id']),
        caption: str(a['caption']),
      }),
    );
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return {
      ...this.toItem(ctx.client, r, this.now()),
      fields,
      attachments,
      contact:
        r.lead.contactId && r.waId
          ? { id: r.lead.contactId, name: r.contactName, waId: r.waId }
          : null,
      contactedAt: iso(r.lead.contactedAt),
      quotedAt: iso(r.lead.quotedAt),
      closedAt: iso(r.lead.closedAt),
      ownerRemindedAt: iso(r.lead.ownerRemindedAt),
      adminRemindedAt: iso(r.lead.adminRemindedAt),
      responseTimeHours: responseHours(ctx.client),
      notes: notes.map((n): AdminLeadNote => ({
        id: n.note.id,
        body: n.note.body,
        author: person(n),
        createdAt: n.note.createdAt.toISOString(),
      })),
      events: events.map((e): AdminLeadEvent => ({
        id: e.event.id,
        kind: e.event.kind as LeadEventKind,
        actor: person(e),
        data: e.event.data,
        createdAt: e.event.createdAt.toISOString(),
      })),
      owners: candidates(team, r.lead.branchId).map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
      })),
    };
  }

  async changeStatus(
    ctx: AdminContext,
    id: string,
    body: UpdateLeadStatusBody,
  ): Promise<AdminLeadDetail> {
    const r = await this.row(ctx, id);
    await this.setStatus(ctx.client, r.lead, {
      status: body.status,
      lostReason: body.lostReason,
      actorMemberId: ctx.member.id,
      note: body.note,
    });
    return this.detail(ctx, id);
  }

  /**
   * Moves a lead to a status and records who did it. No change, no event. Also for other
   * features that move leads (WA-025 marks a lead `quoted` when its quote is sent); `actorMemberId`
   * null means the system did it.
   */
  async setStatus(
    client: ClientConfig,
    lead: LeadRow,
    change: {
      status: LeadStatus;
      lostReason?: LostReason;
      actorMemberId: string | null;
      note?: string;
    },
  ): Promise<LeadRow> {
    const { status } = change;
    if (status === 'lost' && !change.lostReason) {
      throw adminError(400, 'lost_reason_required', 'Indique o motivo da perda.');
    }
    const lostReason = status === 'lost' ? change.lostReason! : null;
    if (status === lead.status && lostReason === lead.lostReason && !change.note) return lead;
    const now = this.now();
    const changed = status !== lead.status || lostReason !== lead.lostReason;
    const updated = await this.deps.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      // A note sent with the change belongs to the status event (one entry in the history).
      const note = change.note
        ? await this.insertNote(db, client.id, lead.id, change.actorMemberId, {
            body: change.note,
            now,
            event: !changed,
          })
        : undefined;
      if (!changed) return lead;
      const [row] = (await tx
        .update(leads)
        .set({
          status,
          lostReason,
          statusChangedAt: now,
          ...(status !== 'new' && !lead.contactedAt && { contactedAt: now }),
          ...(status === 'quoted' && !lead.quotedAt && { quotedAt: now }),
          closedAt: status === 'won' || status === 'lost' ? now : null,
        })
        .where(eq(leads.id, lead.id))
        .returning()) as [LeadRow];
      await tx.insert(leadEvents).values({
        clientId: client.id,
        leadId: lead.id,
        actorMemberId: change.actorMemberId,
        kind: 'status',
        data: {
          from: lead.status,
          to: status,
          ...(lostReason && { lostReason }),
          ...(note && { noteId: note.id }),
        },
        createdAt: now,
      });
      return row;
    });
    await this.publish(client, updated);
    return updated;
  }

  async changeOwner(
    ctx: AdminContext,
    id: string,
    ownerId: string | null,
  ): Promise<AdminLeadDetail> {
    const r = await this.row(ctx, id);
    if (ownerId === r.lead.ownerMemberId) return this.detail(ctx, id);
    let next: TeamMemberRow | undefined;
    if (ownerId) {
      next = candidates(await this.deps.team.list(ctx.client.id), r.lead.branchId).find(
        (m) => m.id === ownerId,
      );
      if (!next) {
        throw adminError(
          400,
          'invalid_owner',
          'Essa pessoa não trabalha com esta filial. Escolha outro responsável.',
        );
      }
    }
    const now = this.now();
    const updated = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(leads)
        .set({ ownerMemberId: next?.id ?? null })
        .where(eq(leads.id, r.lead.id))
        .returning();
      await tx.insert(leadEvents).values({
        clientId: ctx.client.id,
        leadId: r.lead.id,
        actorMemberId: ctx.member.id,
        kind: 'owner',
        data: {
          from: r.ownerId,
          fromName: r.ownerName ?? r.ownerEmail,
          to: next?.id ?? null,
          toName: next ? (next.name ?? next.email) : null,
        },
        createdAt: now,
      });
      return row!;
    });
    await this.publish(ctx.client, updated, next ? (next.name ?? next.email) : null);
    return this.detail(ctx, id);
  }

  async addNote(ctx: AdminContext, id: string, body: string): Promise<AdminLeadNote> {
    const r = await this.row(ctx, id);
    const note = await this.deps.db.transaction((tx) =>
      this.insertNote(tx as unknown as Db, ctx.client.id, r.lead.id, ctx.member.id, {
        body,
        now: this.now(),
      }),
    );
    return {
      id: note.id,
      body: note.body,
      author: { id: ctx.member.id, name: ctx.member.name, email: ctx.member.email },
      createdAt: note.createdAt.toISOString(),
    };
  }

  private async insertNote(
    db: Db,
    clientId: string,
    leadId: string,
    authorMemberId: string | null,
    note: { body: string; now: Date; event?: boolean },
  ) {
    const [row] = await db
      .insert(leadNotes)
      .values({ clientId, leadId, authorMemberId, body: note.body, createdAt: note.now })
      .returning();
    if (note.event === false) return row!;
    await db.insert(leadEvents).values({
      clientId,
      leadId,
      actorMemberId: authorMemberId,
      kind: 'note',
      data: { noteId: row!.id },
      createdAt: note.now,
    });
    return row!;
  }

  /** The back-office panel shows the lead's new status or owner straight away. */
  private async publish(client: ClientConfig, row: LeadRow, ownerName?: string | null) {
    if (!this.deps.backoffice || !row.contactId) return;
    const [contact] = await this.deps.db
      .select({ waId: contacts.waId })
      .from(contacts)
      .where(eq(contacts.id, row.contactId));
    let name = ownerName;
    if (name === undefined && row.ownerMemberId) {
      const [owner] = await this.deps.db
        .select({ name: teamMembers.name, email: teamMembers.email })
        .from(teamMembers)
        .where(eq(teamMembers.id, row.ownerMemberId));
      name = owner ? (owner.name ?? owner.email) : null;
    }
    if (contact) this.deps.backoffice.publishLead(client, contact.waId, row, name);
  }

  /** The filtered leads as CSV for Excel (pt-PT), newest first, at most 5000. */
  async exportCsv(ctx: AdminContext, filters: LeadFilters): Promise<string> {
    const rows = await this.select()
      .where(this.where(ctx, filters))
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(EXPORT_LIMIT);
    const now = this.now();
    const tz = ctx.client.timezone;
    return toCsv([
      [
        'Data',
        'Tipo',
        'Estado',
        'Motivo da perda',
        'Filial',
        'Responsável',
        'Cliente',
        'Telefone',
        'Email',
        'Localidade',
        'Produtos',
        'Resumo',
        'Contactado em',
        'ID',
      ],
      ...rows.map((r) => {
        const item = this.toItem(ctx.client, r, now);
        const fields = r.lead.fields as Record<string, unknown>;
        return [
          csvDate(r.lead.createdAt, tz),
          leadTypeLabel(item.type),
          leadStatusLabels[item.status],
          item.lostReason ? lostReasonLabels[item.lostReason] : '',
          item.branchName ?? item.branchId,
          item.owner ? (item.owner.name ?? item.owner.email) : '',
          item.name,
          csvPhone(item.phone),
          str(fields['email']),
          str(fields['location']),
          item.products,
          item.summary,
          csvDate(r.lead.contactedAt, tz),
          item.id,
        ];
      }),
    ]);
  }
}

/** Who may own a lead of this branch: the branch's members and every admin. */
function candidates(team: TeamMemberRow[], branchId: string | null): TeamMemberRow[] {
  return team.filter((m) => m.role === 'admin' || (branchId && m.branches.includes(branchId)));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
