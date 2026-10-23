import type { PrivacyRequestType } from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { privacyRequests } from '../db/schema.js';

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;

/**
 * Opens a privacy request for an admin to approve, or returns the one of the same type that is
 * still pending, so a customer who asks twice does not create two.
 */
export async function openPrivacyRequest(
  db: Db,
  input: {
    clientId: string;
    contactId: string;
    type: PrivacyRequestType;
    source: 'whatsapp' | 'dashboard';
  },
): Promise<{ request: PrivacyRequestRow; existing: boolean }> {
  const [pending] = await db
    .select()
    .from(privacyRequests)
    .where(
      and(
        eq(privacyRequests.clientId, input.clientId),
        eq(privacyRequests.contactId, input.contactId),
        eq(privacyRequests.type, input.type),
        eq(privacyRequests.status, 'pending'),
      ),
    )
    .limit(1);
  if (pending) return { request: pending, existing: true };
  const [request] = await db.insert(privacyRequests).values(input).returning();
  return { request: request!, existing: false };
}
