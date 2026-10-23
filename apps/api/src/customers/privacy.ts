/**
 * Personal data handlers of customer records and profiles (WA-027), listed in
 * privacy/handlers.ts. The profile handler implements "clear profile": the profile goes, the
 * history (record, notes, conversations, leads) stays.
 */
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { contacts, customerNotes, customerProfileFields, customers } from '../db/schema.js';
import type { PersonalDataHandler, PrivacyContext } from '../privacy/registry.js';
import { customerIdsOfContacts } from './records.js';

const iso = (d: Date | null) => d?.toISOString() ?? null;

const recordsOf = (ctx: PrivacyContext) =>
  customerIdsOfContacts(ctx.db, ctx.client.id, ctx.contactIds);

async function deleteProfile(ctx: PrivacyContext): Promise<number> {
  const ids = await recordsOf(ctx);
  if (!ids.length) return 0;
  const rows = await ctx.db
    .delete(customerProfileFields)
    .where(
      and(
        eq(customerProfileFields.clientId, ctx.client.id),
        inArray(customerProfileFields.customerId, ids),
      ),
    )
    .returning({ id: customerProfileFields.id });
  return rows.length;
}

/** The profile: what the agent noted and the team set. Runs before conversations (evidence). */
export const customerProfileHandler: PersonalDataHandler = {
  name: 'customer_profile',
  tables: [customerProfileFields],
  order: 80,
  async export(ctx) {
    const ids = await recordsOf(ctx);
    const rows = ids.length
      ? await ctx.db
          .select()
          .from(customerProfileFields)
          .where(
            and(
              eq(customerProfileFields.clientId, ctx.client.id),
              inArray(customerProfileFields.customerId, ids),
            ),
          )
          .orderBy(asc(customerProfileFields.field))
      : [];
    return {
      data: rows.map((r) => ({
        customerId: r.customerId,
        field: r.field,
        value: r.value,
        source: r.source,
        locked: r.locked,
        evidence: r.evidence,
        conversationId: r.conversationId,
        updatedAt: iso(r.updatedAt),
      })),
    };
  },
  async erase(ctx) {
    return { deleted: await deleteProfile(ctx) };
  },
  clearProfile: deleteProfile,
};

/**
 * The record and the team's notes. A record goes with its last number; if the record keeps
 * other numbers (a single number was deleted), only the link of the deleted ones goes.
 */
export const customerRecordsHandler: PersonalDataHandler = {
  name: 'customer_records',
  tables: [customers, customerNotes],
  order: 95,
  async export(ctx) {
    const ids = await recordsOf(ctx);
    if (!ids.length) return { data: [] };
    const records = await ctx.db
      .select()
      .from(customers)
      .where(and(eq(customers.clientId, ctx.client.id), inArray(customers.id, ids)));
    const notes = await ctx.db
      .select()
      .from(customerNotes)
      .where(and(eq(customerNotes.clientId, ctx.client.id), inArray(customerNotes.customerId, ids)))
      .orderBy(asc(customerNotes.createdAt));
    return {
      data: records.map((r) => ({
        id: r.id,
        name: r.name,
        company: r.company,
        nif: r.nif,
        role: r.role,
        regions: r.regions,
        createdAt: iso(r.createdAt),
        notes: notes
          .filter((n) => n.customerId === r.id)
          .map((n) => ({ body: n.body, createdAt: iso(n.createdAt) })),
      })),
    };
  },
  async erase(ctx) {
    const ids = await recordsOf(ctx);
    if (!ids.length) return { deleted: 0 };
    const remaining = await ctx.db
      .selectDistinct({ id: contacts.customerId })
      .from(contacts)
      .where(
        and(
          eq(contacts.clientId, ctx.client.id),
          inArray(contacts.customerId, ids),
          ctx.contactIds.length ? notInArray(contacts.id, ctx.contactIds) : sql`true`,
        ),
      );
    const kept = new Set(remaining.map((r) => r.id));
    const gone = ids.filter((id) => !kept.has(id));
    await ctx.db
      .update(contacts)
      .set({ customerId: null })
      .where(and(eq(contacts.clientId, ctx.client.id), inArray(contacts.id, ctx.contactIds)));
    if (!gone.length) return { deleted: 0 };
    const rows = await ctx.db
      .delete(customers)
      .where(and(eq(customers.clientId, ctx.client.id), inArray(customers.id, gone)))
      .returning({ id: customers.id });
    return { deleted: rows.length };
  },
};
