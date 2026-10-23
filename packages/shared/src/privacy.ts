/**
 * Privacy tools (WA-028): request bodies and the JSON the admin API answers with, below
 * /api/admin/clients/:clientId/privacy. Admins only.
 */
import { z } from 'zod';

export type PrivacyRequestType = 'export' | 'delete' | 'clear_profile';
export type PrivacyRequestStatus = 'pending' | 'done' | 'rejected';
export type PrivacyAuditAction =
  'export' | 'clear_profile' | 'delete' | 'retention_delete' | 'request_rejected';

/** Rows changed per table, e.g. `{ messages: 12, leads: 1 }`. */
export type PrivacyCounts = Record<string, number>;

/** A customer as the privacy screens show them: one WhatsApp contact for now (WA-027: a record). */
export interface PrivacyCustomer {
  contactId: string;
  name: string | null;
  /** WhatsApp number, digits only. */
  phone: string;
  createdAt: string;
  lastActivityAt: string;
  conversations: number;
  leads: number;
  profilingOptOut: boolean;
  pendingRequests: number;
}

export interface PrivacyRequestView {
  id: string;
  type: PrivacyRequestType;
  status: PrivacyRequestStatus;
  source: 'whatsapp' | 'dashboard';
  /** Null once the customer was deleted. */
  customer: Pick<PrivacyCustomer, 'contactId' | 'name' | 'phone'> | null;
  createdAt: string;
  decidedAt: string | null;
  /** Name or email of the admin who decided. */
  decidedBy: string | null;
  result: PrivacyCounts | null;
}

/** GET /privacy/retention: whom the scheduled job deletes in the next days. */
export interface PrivacyRetentionView {
  months: number;
  /** The list holds contacts whose deletion date is within this many days (or has passed). */
  days: number;
  due: (PrivacyCustomer & { deleteOn: string })[];
}

export interface PrivacyAuditEntry {
  id: string;
  action: PrivacyAuditAction;
  /** Name or email of the member; null for the scheduled job. */
  actor: string | null;
  /** Hash of the contact id, never the person. */
  targetHash: string;
  requestId: string | null;
  counts: PrivacyCounts;
  createdAt: string;
}

/** POST /privacy/customers/:contactId/delete. */
export const privacyDeleteSchema = z.object({
  /** The customer's name or phone number, typed by the admin. */
  confirm: z.string().trim().min(1).max(200),
});
export type PrivacyDeleteBody = z.infer<typeof privacyDeleteSchema>;

/** POST /privacy/requests/:id/approve. */
export const privacyApproveSchema = z.object({
  /** Delete requests only: the customer's name or phone, typed by the admin. */
  confirm: z.string().trim().max(200).optional(),
});
export type PrivacyApproveBody = z.infer<typeof privacyApproveSchema>;

export interface PrivacyActionResult {
  counts: PrivacyCounts;
  /** Whether the customer was told on WhatsApp (requests only). */
  notified?: boolean;
}

/** Digits only, for comparing numbers typed with spaces or a leading +. */
export const phoneDigits = (s: string) => s.replace(/\D+/g, '');

const normalName = (s: string) => s.trim().toLocaleLowerCase('pt-PT').replace(/\s+/g, ' ');

/**
 * Whether `typed` names this customer: their name (any case) or their number, with or without
 * the country code.
 */
export function confirmsCustomer(
  typed: string,
  customer: { name: string | null; phone: string },
): boolean {
  if (!typed.trim()) return false;
  if (customer.name && normalName(typed) === normalName(customer.name)) return true;
  if (/[a-z]/i.test(typed)) return false;
  const digits = phoneDigits(typed);
  return digits === customer.phone || (digits.length >= 9 && customer.phone.endsWith(digits));
}
