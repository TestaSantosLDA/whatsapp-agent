/**
 * The personal data handlers of the tables that exist today (WA-028). A feature that adds a table
 * with customer data writes its handler (next to its code or here) and adds it to
 * `personalDataHandlers`; the schema coverage test fails until it does.
 */
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  agentRuns,
  contacts,
  conversations,
  leads,
  messages,
  outbox,
  privacyRequests,
} from '../db/schema.js';
import { quotesHandler } from '../admin/quotes/privacy.js';
import type { PersonalDataHandler, PrivacyContext } from './registry.js';

const count = (rows: unknown[]) => rows.length;
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Lead fields kept on an anonymised lead: what the stats need, nothing that names anyone. */
const KEPT_LEAD_FIELDS = ['request_type', 'business_line', 'area_m2'];

/** Media a message carries, as WhatsApp describes it (id for inbound, link for outbound). */
const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;

function leadsOfSubject(ctx: PrivacyContext): SQL {
  return and(
    eq(leads.clientId, ctx.client.id),
    or(
      inArray(leads.contactId, ctx.contactIds),
      inArray(leads.conversationId, ctx.conversationIds),
      // Leads stored with the number but no link (e.g. written by an import); save_lead writes
      // it as +351..., so compare digits only.
      inArray(
        sql`regexp_replace(${leads.fields}->>'phone', '[^0-9]', '', 'g')`,
        ctx.identifiers.phones,
      ),
    ),
  )!;
}

/** Emails about the person: from their conversations, naming their number or sent to them. */
function emailsOfSubject(ctx: PrivacyContext): SQL {
  const { phones, emails } = ctx.identifiers;
  return and(
    eq(outbox.clientId, ctx.client.id),
    or(
      inArray(outbox.conversationId, ctx.conversationIds),
      ...phones.map((p) => ilike(outbox.body, `%${p}%`)),
      ...phones.map((p) => ilike(outbox.subject, `%${p}%`)),
      emails.length
        ? sql`${outbox.to} && ARRAY[${sql.join(
            emails.map((e) => sql`${e}`),
            sql`, `,
          )}]::text[]`
        : undefined,
    ),
  )!;
}

export const contactsHandler: PersonalDataHandler = {
  name: 'contacts',
  tables: [contacts],
  order: 100,
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clientId, ctx.client.id), inArray(contacts.id, ctx.contactIds)));
    return {
      data: rows.map((r) => ({
        id: r.id,
        phone: r.waId,
        name: r.name,
        language: r.language,
        consent: r.consent,
        profilingOptOut: r.profilingOptOut,
        createdAt: iso(r.createdAt),
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .delete(contacts)
      .where(and(eq(contacts.clientId, ctx.client.id), inArray(contacts.id, ctx.contactIds)))
      .returning({ id: contacts.id });
    return { deleted: count(rows) };
  },
};

export const conversationsHandler: PersonalDataHandler = {
  name: 'conversations',
  tables: [conversations],
  order: 90,
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, ctx.conversationIds))
      .orderBy(asc(conversations.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        status: r.status,
        createdAt: iso(r.createdAt),
        lastActivityAt: iso(r.lastActivityAt),
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .delete(conversations)
      .where(inArray(conversations.id, ctx.conversationIds))
      .returning({ id: conversations.id });
    return { deleted: count(rows) };
  },
};

/** Messages, and the media they reference (files themselves are not stored yet). */
export const messagesHandler: PersonalDataHandler = {
  name: 'messages',
  tables: [messages],
  order: 10,
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(messages)
      .where(inArray(messages.conversationId, ctx.conversationIds))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const media = rows.flatMap((r) => {
      const payload = r.payload as Record<string, unknown>;
      const type = MEDIA_TYPES.find((t) => payload[t]);
      if (!type) return [];
      const m = payload[type] as Record<string, unknown>;
      return [
        {
          messageId: r.id,
          direction: r.direction,
          type,
          mediaId: m.id ?? null,
          link: m.link ?? null,
          mimeType: m.mime_type ?? null,
          caption: m.caption ?? null,
          filename: m.filename ?? null,
        },
      ];
    });
    return {
      data: {
        messages: rows.map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          direction: r.direction,
          type: r.type,
          text: r.text,
          status: r.status,
          createdAt: iso(r.createdAt),
          payload: r.payload,
        })),
        // Inbound media are only referenced by WhatsApp media id until media are downloaded and
        // stored (WA-030); then return them as `files` so they land in the ZIP's media/ folder.
        media,
      },
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .delete(messages)
      .where(inArray(messages.conversationId, ctx.conversationIds))
      .returning({ id: messages.id });
    return { deleted: count(rows) };
  },
};

/** Leads are anonymised, not deleted: type, branch, status and dates stay for the numbers. */
export const leadsHandler: PersonalDataHandler = {
  name: 'leads',
  tables: [leads],
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(leads)
      .where(leadsOfSubject(ctx))
      .orderBy(asc(leads.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        type: r.type,
        branchId: r.branchId,
        status: r.status,
        fields: r.fields,
        conversationId: r.conversationId,
        createdAt: iso(r.createdAt),
      })),
    };
  },
  async erase(ctx) {
    const kept = sql.join(
      KEPT_LEAD_FIELDS.map((k) => sql`${k}::text, ${leads.fields}->${k}`),
      sql`, `,
    );
    const rows = await ctx.db
      .update(leads)
      .set({
        contactId: null,
        conversationId: null,
        fields: sql`jsonb_strip_nulls(jsonb_build_object(${kept})) || '{"anonymised": true}'::jsonb`,
      })
      .where(leadsOfSubject(ctx))
      .returning({ id: leads.id });
    return { anonymised: count(rows) };
  },
};

/** Emails to the team about the person (lead, handoff and order emails). */
export const outboxHandler: PersonalDataHandler = {
  name: 'emails',
  tables: [outbox],
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(outbox)
      .where(emailsOfSubject(ctx))
      .orderBy(asc(outbox.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        to: r.to,
        subject: r.subject,
        body: r.body,
        sentAt: iso(r.sentAt),
        createdAt: iso(r.createdAt),
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .delete(outbox)
      .where(emailsOfSubject(ctx))
      .returning({ id: outbox.id });
    return { deleted: count(rows) };
  },
};

/**
 * Agent turns: tool inputs and outputs repeat what the customer said. On delete the turn stays for
 * cost and latency figures, without its conversation, tool inputs, outputs or error text.
 */
export const agentRunsHandler: PersonalDataHandler = {
  name: 'agent_runs',
  tables: [agentRuns],
  async export(ctx) {
    const rows = await ctx.db
      .select({
        id: agentRuns.id,
        conversationId: agentRuns.conversationId,
        toolCalls: agentRuns.toolCalls,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(inArray(agentRuns.conversationId, ctx.conversationIds))
      .orderBy(asc(agentRuns.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        toolCalls: r.toolCalls,
        createdAt: iso(r.createdAt),
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .update(agentRuns)
      .set({
        conversationId: null,
        toolCalls: sql`(select coalesce(jsonb_agg(jsonb_build_object('name', e->'name', 'ok', e->'ok', 'ms', e->'ms')), '[]'::jsonb) from jsonb_array_elements(${agentRuns.toolCalls}) e)`,
        error: sql`case when ${agentRuns.error} is null then null else '[removed]' end`,
      })
      .where(inArray(agentRuns.conversationId, ctx.conversationIds))
      .returning({ id: agentRuns.id });
    return { anonymised: count(rows) };
  },
};

/** The person's own privacy requests: kept as a record, without the link to them. */
export const privacyRequestsHandler: PersonalDataHandler = {
  name: 'privacy_requests',
  tables: [privacyRequests],
  async export(ctx) {
    const rows = await ctx.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.clientId, ctx.client.id),
          inArray(privacyRequests.contactId, ctx.contactIds),
        ),
      )
      .orderBy(asc(privacyRequests.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        source: r.source,
        createdAt: iso(r.createdAt),
        decidedAt: iso(r.decidedAt),
      })),
    };
  },
  async erase(ctx) {
    const rows = await ctx.db
      .update(privacyRequests)
      .set({ contactId: null })
      .where(
        and(
          eq(privacyRequests.clientId, ctx.client.id),
          inArray(privacyRequests.contactId, ctx.contactIds),
        ),
      )
      .returning({ id: privacyRequests.id });
    return { anonymised: count(rows) };
  },
};

/**
 * Every handler the privacy tools run. Add one line per feature table holding customer data
 * (WA-023 inbox, WA-024 lead notes and events, WA-025 quotes, WA-026 documents, WA-027 customer
 * records and profiles: the profile handler implements `clearProfile`).
 */
export const personalDataHandlers: PersonalDataHandler[] = [
  contactsHandler,
  conversationsHandler,
  messagesHandler,
  leadsHandler,
  outboxHandler,
  agentRunsHandler,
  privacyRequestsHandler,
  quotesHandler,
];
