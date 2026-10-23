/**
 * Customer records (WA-027): every WhatsApp contact belongs to one record (contacts.customer_id),
 * created with the contact (MessageService.upsertContact; older contacts got theirs in migration
 * 0003), or, for a contact made another way, the first time it is needed (an agent turn, the
 * inbox's customer card). One record can hold several numbers of the same person or company. Every query is scoped by client: a record, its numbers
 * and its profile belong to one client and are never read for another.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contacts, customers } from '../db/schema.js';
import type { SubjectResolver } from '../privacy/service.js';

export type CustomerRow = typeof customers.$inferSelect;

/** The contact's record, created if it has none yet. Undefined for an unknown contact. */
export async function ensureCustomer(
  db: Db,
  clientId: string,
  contactId: string,
): Promise<string | undefined> {
  const [contact] = await db
    .select({ customerId: contacts.customerId })
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), eq(contacts.id, contactId)));
  if (!contact) return undefined;
  if (contact.customerId) return contact.customerId;
  return db.transaction(async (tx) => {
    const [record] = await tx.insert(customers).values({ clientId }).returning();
    const linked = await tx
      .update(contacts)
      .set({ customerId: record!.id })
      .where(and(eq(contacts.id, contactId), isNull(contacts.customerId)))
      .returning({ id: contacts.id });
    if (linked.length) return record!.id;
    // Someone linked it at the same time: use theirs.
    await tx.delete(customers).where(eq(customers.id, record!.id));
    const [again] = await tx
      .select({ customerId: contacts.customerId })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    return again?.customerId ?? undefined;
  });
}

/** The record's contact ids, oldest first. */
export async function contactIdsOfCustomer(
  db: Db,
  clientId: string,
  customerId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), eq(contacts.customerId, customerId)))
    .orderBy(contacts.createdAt);
  return rows.map((r) => r.id);
}

/** Records of these contacts (distinct). */
export async function customerIdsOfContacts(
  db: Db,
  clientId: string,
  contactIds: string[],
): Promise<string[]> {
  if (!contactIds.length) return [];
  const rows = await db
    .selectDistinct({ id: contacts.customerId })
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), inArray(contacts.id, contactIds)));
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}

/** Whether any number of the record objected to profiling (WA-028 "clear profile"). */
export async function customerOptedOut(
  db: Db,
  clientId: string,
  customerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, clientId),
        eq(contacts.customerId, customerId),
        eq(contacts.profilingOptOut, true),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * For the privacy tools (WA-028): a customer is every number of their record, so export, clear
 * profile and delete cover all of them. A contact without a record is just itself.
 */
export const customerSubject: SubjectResolver = {
  async contactIds(db, clientId, contactId) {
    const [row] = await db
      .select({ id: contacts.id, customerId: contacts.customerId })
      .from(contacts)
      .where(and(eq(contacts.clientId, clientId), eq(contacts.id, contactId)));
    if (!row) return [];
    if (!row.customerId) return [row.id];
    const ids = await contactIdsOfCustomer(db, clientId, row.customerId);
    return ids.length ? ids : [row.id];
  },
};
