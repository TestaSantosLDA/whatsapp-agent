/**
 * Quotes in the privacy tools (WA-028, for WA-025). Export: every quote of the customer, and the
 * PDFs they were sent. Delete: the quote stays without the customer (number, lines, totals and
 * dates keep the numbering and the figures right); its PDF, public link, notes and delivery
 * addresses go.
 */
import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { quotePdfs, quotes } from '../../db/schema.js';
import type { PersonalDataHandler, PrivacyContext } from '../../privacy/registry.js';

const EMPTY_CUSTOMER = {
  name: null,
  company: null,
  nif: null,
  email: null,
  phone: null,
  address: null,
};

function quotesOfSubject(ctx: PrivacyContext): SQL {
  return and(
    eq(quotes.clientId, ctx.client.id),
    or(
      inArray(quotes.contactId, ctx.contactIds),
      inArray(quotes.conversationId, ctx.conversationIds),
    ),
  )!;
}

export const quotesHandler: PersonalDataHandler = {
  name: 'quotes',
  tables: [quotes, quotePdfs],
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(quotes)
      .where(quotesOfSubject(ctx))
      .orderBy(asc(quotes.createdAt));
    const sent = rows.filter((r) => r.status === 'sent').map((r) => r.id);
    const files = sent.length
      ? await ctx.db
          .select({ quoteId: quotePdfs.quoteId, filename: quotePdfs.filename })
          .from(quotePdfs)
          .where(inArray(quotePdfs.quoteId, sent))
      : [];
    return {
      data: rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        leadId: r.leadId,
        customer: r.customer,
        lines: r.lines,
        discount: r.discount,
        validUntil: r.validUntil,
        fulfilment: r.fulfilment,
        notes: r.notes,
        totalCents: r.totalCents,
        sends: r.sends,
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
      })),
      files: files.map((f) => ({
        path: `quotes/${f.filename}`,
        read: async () => {
          const [file] = await ctx.db
            .select({ content: quotePdfs.content })
            .from(quotePdfs)
            .where(eq(quotePdfs.quoteId, f.quoteId));
          return file?.content ?? new Uint8Array();
        },
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .select({ id: quotes.id, sends: quotes.sends })
      .from(quotes)
      .where(quotesOfSubject(ctx));
    if (!rows.length) return { anonymised: 0 };
    const ids = rows.map((r) => r.id);
    await ctx.db.delete(quotePdfs).where(inArray(quotePdfs.quoteId, ids));
    for (const r of rows) {
      await ctx.db
        .update(quotes)
        .set({
          contactId: null,
          conversationId: null,
          customer: EMPTY_CUSTOMER,
          fulfilment: null,
          notes: null,
          publicToken: null,
          // Keep when and how it was sent, not where to.
          sends: (r.sends as Record<string, unknown>[]).map((s) => ({ ...s, to: '' })),
        })
        .where(eq(quotes.id, r.id));
    }
    return { anonymised: rows.length };
  },
};
