/**
 * Personal data handlers (WA-028). Every table that holds data about a customer registers a
 * handler that can export it and erase it; the privacy tools (export, clear profile, delete,
 * retention) only ever go through these handlers, so a feature that adds a table adds its handler
 * next to it and lists it in privacy/handlers.ts. A test fails when a table linked to a contact,
 * conversation, customer record or lead (by a `*_id` column or a foreign key, followed through
 * other personal tables) has no handler.
 */
import type { ClientConfig } from '@wa/shared';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/index.js';

/** The person the privacy tools act on, and what is known about them. */
export interface PrivacyContext {
  /** The transaction while erasing; the database while exporting. */
  db: Db;
  client: ClientConfig;
  now: Date;
  /** The subject's WhatsApp contacts (one today; a customer record's contacts from WA-027). */
  contactIds: string[];
  /** Every conversation of those contacts. */
  conversationIds: string[];
  /**
   * Values that identify the person, collected before anything is erased, for handlers that must
   * find them in free text or rows without a contact link (e.g. emails about them).
   */
  identifiers: { phones: string[]; names: string[]; emails: string[] };
}

/** A file for the export ZIP, read only while the ZIP is streamed. */
export interface ExportFile {
  /** Path below `media/` in the ZIP, e.g. `documents/quote-JUL-2026-0042.pdf`. */
  path: string;
  read(): Promise<Uint8Array | AsyncIterable<Uint8Array>>;
}

export interface PersonalDataExport {
  /** JSON-serialisable; goes into data.json under the handler's name. */
  data: unknown;
  files?: ExportFile[];
}

/** Rows a handler removed, and rows it kept without personal content (for counts and stats). */
export interface EraseResult {
  deleted?: number;
  anonymised?: number;
}

export interface PersonalDataHandler {
  /** Key in data.json and in the delete counts, e.g. `leads`. */
  name: string;
  /** The tables it covers, checked by the schema coverage test. */
  tables: PgTable[];
  /**
   * Erase runs in ascending order (default 0), so rows that reference conversations or contacts
   * go before them: conversations run at 90, contacts at 100.
   */
  order?: number;
  export(ctx: PrivacyContext): Promise<PersonalDataExport>;
  /**
   * Removes the subject's rows, or keeps them without personal content where counts must stay
   * right (leads, quotes, agent costs). Runs inside the delete transaction.
   */
  erase(ctx: PrivacyContext): Promise<EraseResult>;
  /**
   * "Clear profile": removes what profiling built about the person, keeping their history.
   * WA-027 registers the profile handler; others leave it out. Returns rows removed.
   */
  clearProfile?(ctx: PrivacyContext): Promise<number>;
}

/** Tables that hold data about a customer by definition. */
const SUBJECT_TABLES = ['contacts', 'conversations', 'customers', 'leads'];

/** Columns that link a row to a customer, whether or not they carry a foreign key. */
const SUBJECT_COLUMNS = ['contact_id', 'conversation_id', 'customer_id', 'lead_id'];

/**
 * Tables that may hold data about a customer: contacts, conversations, customer records and leads,
 * a table with a column linking to one of them, and, following foreign keys, every table that
 * references a table already found (e.g. a lead's notes, a quote's lines).
 */
export function personalTables(schema: Record<string, unknown>): PgTable[] {
  const tables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
  const found = new Set<string>(
    tables
      .map((t) => getTableConfig(t))
      .filter(
        (config) =>
          SUBJECT_TABLES.includes(config.name) ||
          config.columns.some((c) => SUBJECT_COLUMNS.includes(c.name)),
      )
      .map((config) => config.name),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const table of tables) {
      const config = getTableConfig(table);
      if (found.has(config.name)) continue;
      const refs = config.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name);
      if (refs.some((name) => found.has(name))) {
        found.add(config.name);
        grew = true;
      }
    }
  }
  return tables.filter((t) => found.has(getTableConfig(t).name));
}

/** Names of personal tables that no handler covers. */
export function tablesWithoutHandler(
  schema: Record<string, unknown>,
  handlers: PersonalDataHandler[],
): string[] {
  const covered = new Set(handlers.flatMap((h) => h.tables));
  return personalTables(schema)
    .filter((t) => !covered.has(t))
    .map((t) => getTableConfig(t).name);
}
