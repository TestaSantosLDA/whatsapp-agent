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

/** One row per agent turn, for cost, latency and debugging. */
export const agentRuns = pgTable('agent_runs', {
  id: id(),
  clientId: clientId(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
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
  kind: text('kind').notNull(),
  to: text('to').array().notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  createdAt: createdAt(),
});
