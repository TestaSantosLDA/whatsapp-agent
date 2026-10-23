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

// ---------- WA-026: knowledge base ----------

/** A file the team uploaded (technical sheet, price list, catalogue). The file is in the FileStore. */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    clientId: clientId(),
    /** The file name as uploaded; the agent cites the document by it. */
    name: text('name').notNull(),
    /** pdf | xlsx | csv | docx | png | jpg */
    type: text('type').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Key in the FileStore: `<clientId>/<documentId>/<filename>`. */
    storagePath: text('storage_path').notNull(),
    status: text('status', { enum: ['processing', 'needs_review', 'live', 'failed'] })
      .notNull()
      .default('processing'),
    /** Bumped on every replace, so a job for an older file does not write over the new one. */
    version: integer('version').notNull().default(1),
    error: text('error'),
    uploadedBy: uuid('uploaded_by').references(() => teamMembers.id, { onDelete: 'set null' }),
    /** The extraction's model, tokens and estimated cost. */
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_client').on(t.clientId, t.createdAt)],
);

/** A page (PDF), sheet chunk (XLSX/CSV) or section (DOCX) of a document, for search_documents. */
export const documentPassages = pgTable(
  'document_passages',
  {
    id: id(),
    clientId: clientId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** 1-based page, sheet chunk or section number. */
    page: integer('page').notNull(),
    /** e.g. "Folha Preços, linhas 2–40". */
    label: text('label'),
    text: text('text').notNull(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('portuguese', coalesce(${documentPassages.label}, '') || ' ' || ${documentPassages.text}), 'A') || setweight(to_tsvector('simple', ${documentPassages.text}), 'B')`,
    ),
  },
  (t) => [
    index('document_passages_document').on(t.documentId, t.page),
    index('document_passages_search').using('gin', t.searchVector),
  ],
);

/** A product field value Claude read in a document, waiting for an admin (WA-026). */
export const productDataProposals = pgTable(
  'product_data_proposals',
  {
    id: id(),
    clientId: clientId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    page: integer('page'),
    /** Handle, SKU or variant id, like the keys of `product_data` in the client YAML. */
    productKey: text('product_key'),
    /** The matched product's title, or the name Claude read when nothing matched. */
    productLabel: text('product_label').notNull(),
    field: text('field').notNull(),
    value: jsonb('value').notNull(),
    /** The approved value when an admin edited it. */
    editedValue: jsonb('edited_value'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    quote: text('quote'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'edited'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => teamMembers.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('product_data_proposals_document').on(t.documentId)],
);

/**
 * Approved product data (WA-026), merged over clients/<id>.yaml `product_data` into the
 * catalogue's `extra` (DB wins over YAML; variant id > SKU > handle within each).
 */
export const productDataOverrides = pgTable(
  'product_data_overrides',
  {
    id: id(),
    clientId: clientId(),
    productKey: text('product_key').notNull(),
    field: text('field').notNull(),
    value: jsonb('value').notNull(),
    /** Where the value came from; kept when the document is deleted unless the data is too. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    proposalId: uuid('proposal_id').references(() => productDataProposals.id, {
      onDelete: 'set null',
    }),
    approvedBy: uuid('approved_by').references(() => teamMembers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_data_overrides_key').on(t.clientId, t.productKey, t.field)],
);
