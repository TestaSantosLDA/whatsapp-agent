import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const id = () => uuid('id').primaryKey().defaultRandom();
const clientId = () => text('client_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** One row per customer phone number per client. */
export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    clientId: clientId(),
    waId: text('wa_id').notNull(),
    name: text('name'),
    language: text('language'),
    consent: jsonb('consent').$type<Record<string, boolean>>().notNull().default({}),
    /** WA-028: the customer objected to profiling ("clear profile"); WA-027 must not build one. */
    profilingOptOut: boolean('profiling_opt_out').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('contacts_client_wa_id').on(t.clientId, t.waId)],
);

/** A thread with one contact. Only one conversation per contact is open (not closed) at a time. */
export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    clientId: clientId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    status: text('status', { enum: ['bot', 'human', 'closed'] })
      .notNull()
      .default('bot'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('conversations_contact').on(t.contactId),
    uniqueIndex('conversations_one_open_per_contact')
      .on(t.contactId)
      .where(sql`${t.status} <> 'closed'`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    clientId: clientId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    /** WhatsApp message id (wamid...). Unique per client, so duplicate webhook deliveries are dropped. */
    channelMessageId: text('channel_message_id').notNull(),
    type: text('type').notNull(),
    /** Plain-text view of the message, for history and search. */
    text: text('text'),
    /** The inbound webhook message or the outbound send-message body, as sent on the wire. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_client_channel_id').on(t.clientId, t.channelMessageId),
    index('messages_conversation').on(t.conversationId, t.createdAt),
  ],
);

/**
 * One row per agent turn, for cost, latency and debugging. When a customer is deleted (WA-028)
 * the row is kept for cost figures, without its conversation and without tool inputs and outputs.
 */
export const agentRuns = pgTable('agent_runs', {
  id: id(),
  clientId: clientId(),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  toolCalls: jsonb('tool_calls').notNull().default([]),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  createdAt: createdAt(),
});

/** Catalogue synced from the client's store, one row per variant. */
export const products = pgTable(
  'products',
  {
    id: id(),
    clientId: clientId(),
    productId: text('product_id').notNull(),
    variantId: text('variant_id').notNull(),
    sku: text('sku'),
    title: text('title').notNull(),
    variantTitle: text('variant_title'),
    productType: text('product_type'),
    vendor: text('vendor'),
    tags: text('tags').array().notNull().default([]),
    description: text('description'),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    compareAtPrice: numeric('compare_at_price', { precision: 12, scale: 2 }),
    available: boolean('available').notNull(),
    url: text('url').notNull(),
    imageUrl: text('image_url'),
    extra: jsonb('extra').notNull().default({}),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('portuguese', coalesce(${products.title}, '') || ' ' || coalesce(${products.variantTitle}, '')), 'A') || setweight(to_tsvector('portuguese', coalesce(${products.productType}, '') || ' ' || coalesce(${products.vendor}, '')), 'B') || setweight(to_tsvector('portuguese', coalesce(${products.description}, '')), 'C') || setweight(to_tsvector('simple', coalesce(${products.sku}, '') || ' ' || coalesce(${products.vendor}, '') || ' ' || coalesce(${products.title}, '')), 'A')`,
    ),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('products_client_variant').on(t.clientId, t.variantId),
    index('products_search').using('gin', t.searchVector),
  ],
);

export const leads = pgTable('leads', {
  id: id(),
  clientId: clientId(),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  type: text('type').notNull(),
  branchId: text('branch_id'),
  fields: jsonb('fields').notNull().default({}),
  status: text('status').notNull().default('new'),
  createdAt: createdAt(),
});

/** Emails and other notifications produced for the business. The mock mailer stops here. */
export const outbox = pgTable('outbox', {
  id: id(),
  clientId: clientId(),
  /** The conversation the email is about, when there is one (shown in the back-office panel). */
  conversationId: uuid('conversation_id').references(() => conversations.id),
  kind: text('kind').notNull(),
  to: text('to').array().notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  createdAt: createdAt(),
});

/**
 * The client's team (WA-022). Keyed by the Supabase Auth user id once the person has signed in;
 * until then (`user_id` empty) the row waits for the invited email to sign in for the first time.
 */
export const teamMembers = pgTable(
  'team_members',
  {
    id: id(),
    clientId: clientId(),
    /** Supabase Auth user id (`sub` of their JWT). Empty until the first sign-in. */
    userId: uuid('user_id'),
    /** Lower case. */
    email: text('email').notNull(),
    name: text('name'),
    role: text('role', { enum: ['admin', 'sales'] }).notNull(),
    /** Branch ids: the branches a salesperson sees; the branches an admin is alerted for. */
    branches: text('branches').array().notNull().default([]),
    invitedBy: uuid('invited_by'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('team_members_client_email').on(t.clientId, t.email),
    uniqueIndex('team_members_client_user').on(t.clientId, t.userId),
    index('team_members_user').on(t.userId),
  ],
);

/** Settings the team changed in the dashboard, applied on top of clients/<id>.yaml (WA-022). */
export const clientSettings = pgTable('client_settings', {
  clientId: text('client_id').primaryKey(),
  /** A ClientSettingsOverrides object (packages/shared/src/settings.ts). */
  overrides: jsonb('overrides').notNull().default({}),
  updatedBy: uuid('updated_by').references(() => teamMembers.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- WA-028: privacy tools ----------

/**
 * A customer's request about their data, opened by the agent (request_data_deletion) or by the
 * team, waiting for an admin. The contact link is cleared when the customer is deleted; the row
 * stays, without personal content, as a record that the request was carried out.
 */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: id(),
    clientId: clientId(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    type: text('type', { enum: ['export', 'delete', 'clear_profile'] }).notNull(),
    status: text('status', { enum: ['pending', 'done', 'rejected'] })
      .notNull()
      .default('pending'),
    source: text('source', { enum: ['whatsapp', 'dashboard'] })
      .notNull()
      .default('whatsapp'),
    decidedBy: uuid('decided_by').references(() => teamMembers.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Rows changed per table when it was carried out. Counts only. */
    result: jsonb('result').$type<Record<string, number>>(),
    createdAt: createdAt(),
  },
  (t) => [index('privacy_requests_client_status').on(t.clientId, t.status, t.createdAt)],
);

/**
 * Who exported, cleared or deleted what, and when. Never holds personal content: the customer
 * is a hash of their contact id, and `counts` are rows per table.
 */
export const privacyAudit = pgTable(
  'privacy_audit',
  {
    id: id(),
    clientId: clientId(),
    /**
     * The team member (team_members.id); empty for the scheduled retention job. No foreign key:
     * the entry keeps the id after the member leaves the team.
     */
    actorMemberId: uuid('actor_member_id'),
    action: text('action', {
      enum: ['export', 'clear_profile', 'delete', 'retention_delete', 'request_rejected'],
    }).notNull(),
    /** sha256 of the contact id: lets an auditor match entries without naming the person. */
    targetHash: text('target_hash').notNull(),
    requestId: uuid('request_id'),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('privacy_audit_client_time').on(t.clientId, t.createdAt)],
);
