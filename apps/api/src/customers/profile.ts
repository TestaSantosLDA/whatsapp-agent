/**
 * Customer profiles (WA-027): factual service preferences, one row per field. The agent proposes
 * values with note_profile; the team sees, edits and locks them. Rules:
 *
 * - Only the fields and values of `profileValueSchemas` (packages/shared/src/customers.ts) are
 *   ever stored, whoever writes them.
 * - A field the team set or locked is never overwritten by the agent.
 * - No profile is built or used when profiling is off for the client (config) or the customer
 *   objected (contacts.profiling_opt_out, set by WA-028's "clear profile").
 */
import {
  agentProfileFields,
  isProfileField,
  parseProfileValue,
  profileFields,
  type ClientConfig,
  type ProfileField,
  type ProfileUsualProduct,
  type ProfileValue,
  type ProfilingState,
} from '@wa/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { customerProfileFields } from '../db/schema.js';
import { customerOptedOut } from './records.js';

export type ProfileRow = typeof customerProfileFields.$inferSelect;

/** Whether this customer's profile may be built and used now. */
export async function profilingState(
  db: Db,
  client: ClientConfig,
  customerId: string,
): Promise<ProfilingState> {
  if (!client.profiling.enabled) return 'disabled';
  return (await customerOptedOut(db, client.id, customerId)) ? 'opted_out' : 'on';
}

/** The record's profile rows, in the order of `profileFields`. */
export async function profileRows(db: Db, clientId: string, customerId: string) {
  const rows = await db
    .select()
    .from(customerProfileFields)
    .where(
      and(
        eq(customerProfileFields.clientId, clientId),
        eq(customerProfileFields.customerId, customerId),
      ),
    )
    .orderBy(asc(customerProfileFields.field));
  return rows
    .filter((r) => isProfileField(r.field))
    .sort(
      (a, b) =>
        profileFields.indexOf(a.field as ProfileField) -
        profileFields.indexOf(b.field as ProfileField),
    );
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** New products first, then the earlier ones not repeated; at most 8. */
export function mergeUsualProducts(
  earlier: ProfileUsualProduct[],
  noted: ProfileUsualProduct[],
): ProfileUsualProduct[] {
  const key = (p: ProfileUsualProduct) => p.variant_id ?? fold(p.name);
  const seen = new Set(noted.map(key));
  const names = new Set(noted.map((p) => fold(p.name)));
  return [...noted, ...earlier.filter((p) => !seen.has(key(p)) && !names.has(fold(p.name)))].slice(
    0,
    8,
  );
}

export interface AgentNote {
  clientId: string;
  customerId: string;
  conversationId: string;
  /** Checked again here: the tool's schema is not the only gate. */
  values: Partial<Record<ProfileField, unknown>>;
  /** The customer's own words that show it. */
  evidence: string;
  now?: Date;
}

/**
 * Writes what the agent noted, field by field: never a field the team set or locked, never a
 * field outside the agent's list. Returns what was saved and what the team keeps.
 */
export async function noteFromAgent(
  db: Db,
  note: AgentNote,
): Promise<{ saved: ProfileField[]; kept: ProfileField[]; rejected: string[] }> {
  const saved: ProfileField[] = [];
  const kept: ProfileField[] = [];
  const rejected: string[] = [];
  const existing = new Map(
    (await profileRows(db, note.clientId, note.customerId)).map((r) => [r.field, r]),
  );
  for (const [field, raw] of Object.entries(note.values)) {
    if (raw === undefined) continue;
    if (!isProfileField(field) || !agentProfileFields.includes(field)) {
      rejected.push(field);
      continue;
    }
    const parsed = parseProfileValue(field, raw);
    if (!parsed.ok) {
      rejected.push(field);
      continue;
    }
    const before = existing.get(field);
    if (before && (before.locked || before.source === 'team')) {
      kept.push(field);
      continue;
    }
    let value: ProfileValue = parsed.value;
    if (field === 'usual_products' && Array.isArray(before?.value)) {
      value = mergeUsualProducts(
        before.value as ProfileUsualProduct[],
        value as ProfileUsualProduct[],
      );
    }
    const at = note.now ?? new Date();
    const written = await db
      .insert(customerProfileFields)
      .values({
        clientId: note.clientId,
        customerId: note.customerId,
        field,
        value,
        source: 'agent',
        conversationId: note.conversationId,
        evidence: note.evidence,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [customerProfileFields.customerId, customerProfileFields.field],
        set: {
          value,
          conversationId: note.conversationId,
          evidence: note.evidence,
          updatedBy: null,
          updatedAt: at,
        },
        // The team may have set or locked it since it was read.
        setWhere: sql`${customerProfileFields.locked} = false and ${customerProfileFields.source} = 'agent'`,
      })
      .returning({ id: customerProfileFields.id });
    if (written.length) saved.push(field);
    else kept.push(field);
  }
  return { saved, kept, rejected };
}

export class ProfileValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValueError';
  }
}

/**
 * The team sets a field (any field, `price_tier` included) and/or its lock. A value the team
 * sets is theirs: the agent never changes it. Locking an empty field keeps the agent from
 * filling it. Unlocking an empty field removes it.
 */
export async function setFromTeam(
  db: Db,
  input: {
    clientId: string;
    customerId: string;
    field: ProfileField;
    value?: unknown;
    locked?: boolean;
    memberId: string;
    now?: Date;
  },
): Promise<void> {
  const at = input.now ?? new Date();
  const [before] = await db
    .select()
    .from(customerProfileFields)
    .where(
      and(
        eq(customerProfileFields.customerId, input.customerId),
        eq(customerProfileFields.field, input.field),
      ),
    );
  if (input.value === undefined) {
    if (input.locked === undefined) return;
    if (!before) {
      if (!input.locked) return;
      await db.insert(customerProfileFields).values({
        clientId: input.clientId,
        customerId: input.customerId,
        field: input.field,
        value: null,
        source: 'team',
        locked: true,
        updatedBy: input.memberId,
        updatedAt: at,
      });
      return;
    }
    if (!input.locked && before.value === null) {
      await db.delete(customerProfileFields).where(eq(customerProfileFields.id, before.id));
      return;
    }
    await db
      .update(customerProfileFields)
      .set({ locked: input.locked, updatedBy: input.memberId, updatedAt: at })
      .where(eq(customerProfileFields.id, before.id));
    return;
  }
  const parsed = parseProfileValue(input.field, input.value);
  if (!parsed.ok) throw new ProfileValueError(parsed.message);
  const locked = input.locked ?? before?.locked ?? false;
  await db
    .insert(customerProfileFields)
    .values({
      clientId: input.clientId,
      customerId: input.customerId,
      field: input.field,
      value: parsed.value,
      source: 'team',
      locked,
      updatedBy: input.memberId,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [customerProfileFields.customerId, customerProfileFields.field],
      set: {
        value: parsed.value,
        source: 'team',
        locked,
        conversationId: null,
        evidence: null,
        updatedBy: input.memberId,
        updatedAt: at,
      },
    });
}

/** Removes one field (the agent may note it again unless it is locked afterwards). */
export async function removeField(db: Db, customerId: string, field: ProfileField) {
  await db
    .delete(customerProfileFields)
    .where(
      and(eq(customerProfileFields.customerId, customerId), eq(customerProfileFields.field, field)),
    );
}
