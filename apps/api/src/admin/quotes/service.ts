/**
 * Quote drafts (WA-025): create a quote from a lead (prefilled from what the agent gathered),
 * edit it, preview its PDF, and send it to the customer by WhatsApp (as a document) or email.
 * Sending locks the quote, keeps its PDF and moves the lead to `quoted`.
 */
import { randomBytes } from 'node:crypto';
import {
  computeQuoteTotals,
  formatCents,
  type ClientConfig,
  type QuoteChannel,
  type QuoteCustomer,
  type QuoteDetail,
  type QuoteDiscount,
  type QuoteDraft,
  type QuoteLine,
  type QuoteListItem,
  type QuoteSend,
  type SendQuoteBody,
} from '@wa/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import {
  contacts,
  leadEvents,
  leads,
  quoteCounters,
  quotePdfs,
  quotes,
  teamMembers,
} from '../../db/schema.js';
import type { Mailer } from '../../mail/mailer.js';
import type { MessageService } from '../../services/messages.js';
import { adminError, assertBranch, type AdminContext } from '../context.js';
import type { LeadsService } from '../leads/service.js';
import { quoteEmail } from './email.js';
import { localDate, ptDate, type QuotePdfRenderer } from './pdf.js';
import { prefillQuote } from './prefill.js';

export type QuoteRow = typeof quotes.$inferSelect;
type LeadRow = typeof leads.$inferSelect;

/** Lead statuses a sent quote moves forward to `quoted`; won and lost leads stay as they are. */
const BEFORE_QUOTED = new Set(['new', 'contacted']);

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The quote's prefix: `quotes.prefix`, else the client id in capitals (letters and digits). */
export function quotePrefix(client: ClientConfig): string {
  return (
    client.quotes.prefix ??
    (client.id
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10) ||
      'ORC')
  );
}

export const quoteFilename = (number: string) => `Orcamento-${number}.pdf`;

export class QuotesService {
  constructor(
    private readonly deps: {
      db: Db;
      leads: LeadsService;
      messages: MessageService;
      mailer: Mailer;
      pdf: QuotePdfRenderer;
      /** PUBLIC_BASE_URL: WhatsApp fetches the PDF from a link below it. */
      publicBaseUrl: string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The lead, 404 when it is not this client's, 403 when not on the member's branches. */
  private async lead(ctx: AdminContext, id: string): Promise<LeadRow> {
    const [row] = isUuid(id)
      ? await this.deps.db
          .select()
          .from(leads)
          .where(and(eq(leads.clientId, ctx.client.id), eq(leads.id, id)))
      : [];
    if (!row) throw adminError(404, 'not_found', 'Pedido não encontrado.');
    assertBranch(ctx, row.branchId);
    return row;
  }

  private async row(ctx: AdminContext, id: string): Promise<QuoteRow> {
    const [row] = isUuid(id)
      ? await this.deps.db
          .select()
          .from(quotes)
          .where(and(eq(quotes.clientId, ctx.client.id), eq(quotes.id, id)))
      : [];
    if (!row) throw adminError(404, 'not_found', 'Orçamento não encontrado.');
    assertBranch(ctx, row.branchId);
    return row;
  }

  /** The next number of the client's year, e.g. JUL-2026-0042. Atomic: no two quotes share one. */
  private async nextNumber(db: Db, client: ClientConfig, now: Date): Promise<string> {
    const year = Number(localDate(now, client.timezone).slice(0, 4));
    const [row] = await db
      .insert(quoteCounters)
      .values({ clientId: client.id, year, last: 1 })
      .onConflictDoUpdate({
        target: [quoteCounters.clientId, quoteCounters.year],
        set: { last: sql`${quoteCounters.last} + 1` },
      })
      .returning({ last: quoteCounters.last });
    const seq = String(row!.last).padStart(client.quotes.number_digits, '0');
    return `${quotePrefix(client)}-${year}-${seq}`;
  }

  async listForLead(ctx: AdminContext, leadId: string): Promise<QuoteListItem[]> {
    const lead = await this.lead(ctx, leadId);
    const rows = await this.deps.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.clientId, ctx.client.id), eq(quotes.leadId, lead.id)))
      .orderBy(desc(quotes.createdAt));
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      leadId: r.leadId,
      customerName: (r.customer as QuoteCustomer).name ?? null,
      totalCents: r.totalCents,
      validUntil: r.validUntil,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
    }));
  }

  /** A new draft for the lead, numbered, with what the agent gathered. */
  async create(ctx: AdminContext, leadId: string): Promise<QuoteDetail> {
    const lead = await this.lead(ctx, leadId);
    const now = this.now();
    const draft = await prefillQuote(this.deps.db, ctx.client, lead, now);
    const totals = computeQuoteTotals(draft.lines, draft.discount);
    const row = await this.deps.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const number = await this.nextNumber(db, ctx.client, now);
      const [row] = await db
        .insert(quotes)
        .values({
          clientId: ctx.client.id,
          leadId: lead.id,
          conversationId: lead.conversationId,
          contactId: lead.contactId,
          branchId: lead.branchId,
          number,
          ...stored(draft),
          totalCents: totals.totalCents,
          createdBy: ctx.member.id,
          updatedBy: ctx.member.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row!;
    });
    return this.toDetail(ctx, row);
  }

  async detail(ctx: AdminContext, id: string): Promise<QuoteDetail> {
    return this.toDetail(ctx, await this.row(ctx, id));
  }

  /** Saves the salesperson's edits. A sent quote is locked: make a new one to change it. */
  async update(ctx: AdminContext, id: string, draft: QuoteDraft): Promise<QuoteDetail> {
    const row = await this.row(ctx, id);
    if (row.status !== 'draft') throw locked();
    const totals = computeQuoteTotals(draft.lines, draft.discount);
    const [updated] = await this.deps.db
      .update(quotes)
      .set({
        ...stored(draft),
        totalCents: totals.totalCents,
        updatedBy: ctx.member.id,
        updatedAt: this.now(),
      })
      .where(and(eq(quotes.id, row.id), eq(quotes.status, 'draft')))
      .returning();
    if (!updated) throw locked();
    return this.toDetail(ctx, updated);
  }

  /** Deletes a draft. Its number is not given again. */
  async remove(ctx: AdminContext, id: string): Promise<void> {
    const row = await this.row(ctx, id);
    if (row.status !== 'draft') throw locked();
    await this.deps.db.delete(quotes).where(and(eq(quotes.id, row.id), eq(quotes.status, 'draft')));
  }

  /** The PDF: as sent for a sent quote, a preview marked "Rascunho" for a draft. */
  async pdf(ctx: AdminContext, id: string): Promise<{ filename: string; content: Uint8Array }> {
    const row = await this.row(ctx, id);
    if (row.status === 'sent') {
      const [file] = await this.deps.db
        .select()
        .from(quotePdfs)
        .where(eq(quotePdfs.quoteId, row.id));
      if (file) return { filename: file.filename, content: file.content };
    }
    return {
      filename: quoteFilename(row.number),
      content: await this.render(ctx.client, row, this.now(), row.status === 'draft'),
    };
  }

  /** The PDF behind a sent quote's public link (for WhatsApp), or undefined. */
  async publicPdf(token: string): Promise<{ filename: string; content: Uint8Array } | undefined> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    const [file] = await this.deps.db
      .select({ filename: quotePdfs.filename, content: quotePdfs.content })
      .from(quotes)
      .innerJoin(quotePdfs, eq(quotePdfs.quoteId, quotes.id))
      .where(eq(quotes.publicToken, token));
    return file;
  }

  private render(client: ClientConfig, row: QuoteRow, issuedAt: Date, draft: boolean) {
    const d = draftOf(row);
    return this.deps.pdf.render({
      client,
      number: row.number,
      issuedAt,
      validUntil: d.validUntil,
      branch: client.branches.find((b) => b.id === row.branchId),
      customer: d.customer,
      lines: d.lines,
      discount: d.discount,
      totals: computeQuoteTotals(d.lines, d.discount),
      fulfilment: d.fulfilment,
      notes: d.notes,
      draft,
    });
  }

  /**
   * Sends the quote to the customer. The first send locks the quote and keeps its PDF; later
   * sends (another channel, or again) deliver the same PDF. The lead moves to `quoted`.
   */
  async send(ctx: AdminContext, id: string, body: SendQuoteBody): Promise<QuoteDetail> {
    let row = await this.row(ctx, id);
    const client = ctx.client;
    const d = draftOf(row);
    if (!d.lines.length) {
      throw adminError(400, 'empty_quote', 'Adicione pelo menos uma linha ao orçamento.');
    }

    // Where it goes, checked before anything is locked.
    let to: string;
    let waId: string | undefined;
    if (body.channel === 'whatsapp') {
      const [contact] = row.contactId
        ? await this.deps.db.select().from(contacts).where(eq(contacts.id, row.contactId))
        : [];
      if (!contact || !row.conversationId) {
        throw adminError(
          400,
          'no_whatsapp',
          'Este pedido não tem uma conversa de WhatsApp. Envie o orçamento por email.',
        );
      }
      waId = contact.waId;
      to = `+${contact.waId}`;
    } else {
      const email = body.email ?? d.customer.email;
      if (!email) throw adminError(400, 'no_email', 'Indique o email do cliente.');
      to = email;
    }

    const now = this.now();
    if (row.status === 'draft') row = await this.lock(client, row, now);
    const [file] = await this.deps.db.select().from(quotePdfs).where(eq(quotePdfs.quoteId, row.id));
    const pdf = file!;
    const totalCents = row.totalCents;
    const company = client.quotes.company.legal_name ?? client.name;

    if (body.channel === 'whatsapp') {
      const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
      try {
        await this.deps.messages.send(
          client,
          row.conversationId!,
          waId!,
          {
            type: 'document',
            url: `${base}/static/quotes/${row.publicToken}/${pdf.filename}`,
            filename: pdf.filename,
            caption:
              body.message ||
              `Orçamento ${row.number} da ${company}: ${formatCents(totalCents)} com IVA, válido até ${ptDate(row.validUntil)}.`,
          },
          // A person sent it: the inbox shows who, and the agent's history marks it (WA-023).
          { sentByMemberId: ctx.member.id },
        );
      } catch (error) {
        console.error(`[quotes] could not send ${row.number} by WhatsApp`, error);
        throw adminError(
          502,
          'send_failed',
          'O orçamento ficou guardado, mas não foi possível enviá-lo pelo WhatsApp. Tente de novo.',
        );
      }
    } else {
      await this.deps.mailer.send(
        quoteEmail({
          client,
          conversationId: row.conversationId ?? undefined,
          phone: (d.customer.phone ?? '').replace(/\D/g, ''),
          to,
          replyTo: ctx.member.email,
          customerName: d.customer.name,
          number: row.number,
          totalCents,
          validUntil: row.validUntil,
          message: body.message || undefined,
          sender: ctx.member.name ?? company,
          filename: pdf.filename,
          pdf: pdf.content,
        }),
      );
    }

    const send: QuoteSend = {
      channel: body.channel,
      to,
      at: now.toISOString(),
      by: { id: ctx.member.id, name: ctx.member.name, email: ctx.member.email },
    };
    const [updated] = await this.deps.db
      .update(quotes)
      .set({ sends: sql`${quotes.sends} || ${JSON.stringify([send])}::jsonb` })
      .where(eq(quotes.id, row.id))
      .returning();
    await this.markLead(ctx, updated!, body.channel, now);
    return this.toDetail(ctx, updated!);
  }

  /** Draft → sent: renders the final PDF once and keeps it, with a public link token. */
  private async lock(client: ClientConfig, row: QuoteRow, now: Date): Promise<QuoteRow> {
    const content = await this.render(client, row, now, false);
    return this.deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .update(quotes)
        .set({
          status: 'sent',
          sentAt: now,
          publicToken: randomBytes(24).toString('base64url'),
        })
        .where(and(eq(quotes.id, row.id), eq(quotes.status, 'draft')))
        .returning();
      // Someone sent it a moment ago: use theirs.
      if (!locked) {
        const [current] = await tx.select().from(quotes).where(eq(quotes.id, row.id));
        return current!;
      }
      await tx.insert(quotePdfs).values({
        quoteId: row.id,
        clientId: client.id,
        filename: quoteFilename(row.number),
        content,
        createdAt: now,
      });
      return locked;
    });
  }

  /** The lead's history gets the send, and the lead moves to `quoted` unless already past it. */
  private async markLead(ctx: AdminContext, row: QuoteRow, channel: QuoteChannel, now: Date) {
    if (!row.leadId) return;
    const [lead] = await this.deps.db.select().from(leads).where(eq(leads.id, row.leadId));
    if (!lead) return;
    if (BEFORE_QUOTED.has(lead.status)) {
      await this.deps.leads.setStatus(ctx.client, lead, {
        status: 'quoted',
        actorMemberId: ctx.member.id,
      });
    }
    await this.deps.db.insert(leadEvents).values({
      clientId: ctx.client.id,
      leadId: lead.id,
      actorMemberId: ctx.member.id,
      kind: 'quote_sent',
      data: { quoteId: row.id, number: row.number, channel, totalCents: row.totalCents },
      createdAt: now,
    });
  }

  private async toDetail(ctx: AdminContext, row: QuoteRow): Promise<QuoteDetail> {
    const d = draftOf(row);
    const [creator] = row.createdBy
      ? await this.deps.db
          .select({ id: teamMembers.id, name: teamMembers.name, email: teamMembers.email })
          .from(teamMembers)
          .where(eq(teamMembers.id, row.createdBy))
      : [];
    const branch = ctx.client.branches.find((b) => b.id === row.branchId);
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      leadId: row.leadId,
      branchId: row.branchId,
      branchName: branch?.name ?? null,
      ...d,
      totals: computeQuoteTotals(d.lines, d.discount),
      defaultVatPercent: ctx.client.quotes.vat_percent,
      canSendWhatsapp: !!row.conversationId && !!row.contactId,
      sends: row.sends as unknown as QuoteSend[],
      createdBy: creator ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }
}

const locked = () =>
  adminError(
    409,
    'quote_sent',
    'Este orçamento já foi enviado e não pode ser alterado. Crie um novo a partir do pedido.',
  );

/** The editable part as stored. */
function stored(d: QuoteDraft) {
  return {
    customer: d.customer as unknown as Record<string, unknown>,
    lines: d.lines as unknown as Record<string, unknown>[],
    discount: d.discount as unknown as Record<string, unknown> | null,
    validUntil: d.validUntil,
    fulfilment: d.fulfilment,
    notes: d.notes,
  };
}

function draftOf(row: QuoteRow): QuoteDraft {
  return {
    customer: row.customer as unknown as QuoteCustomer,
    lines: row.lines as unknown as QuoteLine[],
    discount: (row.discount ?? null) as QuoteDiscount,
    validUntil: row.validUntil,
    fulfilment: row.fulfilment,
    notes: row.notes,
  };
}
