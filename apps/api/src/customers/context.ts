/**
 * What the agent knows about the customer for this turn (WA-027): the record the team keeps, the
 * profile (only when profiling is on for the client and the customer), and their last orders,
 * quote requests and quotes sent to them (WA-025), for "o mesmo da última vez". It goes into the per-turn system message, never
 * into the cached system prompt, and only ever reads this client's rows.
 */
import {
  customerRoleLabels,
  formatDecimal,
  type ClientConfig,
  type ProfileUsualProduct,
  type QuoteLine,
} from '@wa/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { customers, leads, quotes } from '../db/schema.js';
import type { ContactRow } from '../services/messages.js';
import { profileRows, profilingState } from './profile.js';
import { contactIdsOfCustomer, ensureCustomer } from './records.js';

/** Order drafts, quote requests and sent quotes shown to the agent, newest first. */
const LAST_ORDERS = 3;

const quote = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 160)}"`;

function describeValue(field: string, value: unknown): string {
  if (field === 'usual_products' && Array.isArray(value)) {
    return (value as ProfileUsualProduct[])
      .map(
        (p) =>
          `${p.name}${p.variant_id ? ` (variant ${p.variant_id})` : ''}${p.quantity ? `, usually ${p.quantity}` : ''}`,
      )
      .join('; ');
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function describeLead(row: typeof leads.$inferSelect): string {
  const f = row.fields as Record<string, unknown>;
  const date = row.createdAt.toISOString().slice(0, 10);
  const items = Array.isArray(f['items']) ? (f['items'] as Record<string, unknown>[]) : [];
  const lines = items.map(
    (i) =>
      `${[str(i['title']), str(i['variant'])].filter(Boolean).join(' ')} (variant ${String(i['variant_id'])}) × ${String(i['quantity'])}`,
  );
  const other = Array.isArray(f['other_items'])
    ? (f['other_items'] as Record<string, unknown>[]).map(
        (o) => `${String(o['description'])}${o['quantity'] ? ` (${String(o['quantity'])})` : ''}`,
      )
    : [];
  const what =
    [...lines, ...other].join('; ') ||
    [str(f['products']), f['area_m2'] ? `${String(f['area_m2'])} m²` : undefined]
      .filter(Boolean)
      .join(', ') ||
    str(f['summary']) ||
    'no details';
  const kind = row.type === 'order' ? 'order draft' : `${row.type} request`;
  const where =
    f['fulfilment'] === 'pickup'
      ? `, pickup at ${String(f['pickup_branch'] ?? '?')}`
      : str(f['delivery_address'])
        ? `, delivery to ${str(f['delivery_address'])}`
        : '';
  return `- ${date}, ${kind} (status ${row.status}${where}): ${what}`;
}

/** A quote the team sent: its lines and total as the customer received them. */
function describeQuote(row: typeof quotes.$inferSelect): string {
  const date = (row.sentAt ?? row.createdAt).toISOString().slice(0, 10);
  const lines = (row.lines as unknown as QuoteLine[])
    .map((l) => `${l.description} × ${formatDecimal(l.quantity, 0, 3)} ${l.unit}`)
    .join('; ');
  const total = formatDecimal(row.totalCents / 100, 2, 2);
  return `- ${date}, quote ${row.number} sent by the team (total ${total} € with VAT, valid until ${row.validUntil}): ${lines || 'no lines'}`;
}

/** Lines for the turn's system message; empty when there is nothing to say. */
export async function customerTurnContext(
  db: Db,
  client: ClientConfig,
  contact: ContactRow,
): Promise<string[]> {
  const customerId = await ensureCustomer(db, client.id, contact.id);
  if (!customerId) return [];
  const [record] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.clientId, client.id), eq(customers.id, customerId)));
  if (!record) return [];
  const lines: string[] = [];

  const facts = [
    record.name && `name ${record.name}`,
    record.company && `company ${record.company}`,
    record.role && `role ${customerRoleLabels[record.role]} (${record.role})`,
    record.regions.length && `regions ${record.regions.join(', ')}`,
  ].filter(Boolean);
  if (facts.length) lines.push(`Customer record kept by the team: ${facts.join('; ')}.`);

  const state = await profilingState(db, client, customerId);
  if (state === 'on') {
    const rows = await profileRows(db, client.id, customerId);
    const fields = rows.filter((r) => r.value !== null);
    if (fields.length) {
      lines.push(
        "Customer's service preferences (adapt your replies to them; never mention that you keep them):",
        ...fields.map(
          (r) =>
            `- ${r.field}: ${describeValue(r.field, r.value)}${r.source === 'team' ? ' (set by the team)' : r.evidence ? ` (they said ${quote(r.evidence)})` : ''}`,
        ),
      );
    }
    const locked = rows.filter((r) => r.locked || r.source === 'team').map((r) => r.field);
    if (locked.length) {
      lines.push(`The team keeps these fields; do not note them: ${locked.join(', ')}.`);
    }
  } else if (state === 'opted_out') {
    lines.push(
      'Profiling is off for this customer (they objected): do not call note_profile and do not personalise beyond this conversation.',
    );
  }

  const contactIds = await contactIdsOfCustomer(db, client.id, customerId);
  if (contactIds.length) {
    const [leadRows, quoteRows] = await Promise.all([
      db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.clientId, client.id),
            inArray(leads.contactId, contactIds),
            inArray(leads.type, ['order', 'quote']),
          ),
        )
        .orderBy(desc(leads.createdAt))
        .limit(LAST_ORDERS),
      // Only quotes the customer received: a draft is the team's work in progress.
      db
        .select()
        .from(quotes)
        .where(
          and(
            eq(quotes.clientId, client.id),
            inArray(quotes.contactId, contactIds),
            eq(quotes.status, 'sent'),
          ),
        )
        .orderBy(desc(quotes.sentAt))
        .limit(LAST_ORDERS),
    ]);
    const last = [
      ...leadRows.map((r) => ({ at: r.createdAt, text: describeLead(r) })),
      ...quoteRows.map((r) => ({ at: r.sentAt ?? r.createdAt, text: describeQuote(r) })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, LAST_ORDERS);
    if (last.length) {
      lines.push(
        'Their last order drafts, quote requests and quotes sent, newest first (for "o mesmo da última vez" / "the same as last time"; confirm items and quantities with them before acting, and never promise a quote\'s prices again: the team decides prices):',
        ...last.map((l) => l.text),
      );
    }
  }
  return lines;
}
