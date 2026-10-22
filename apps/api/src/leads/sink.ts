import { randomUUID } from 'node:crypto';
import type { ClientConfig, LeadSinkName } from '@wa/shared';
import type { Db } from '../db/index.js';
import { leads } from '../db/schema.js';
import { BackgroundTasks } from '../services/background.js';
import type { BackofficeService } from '../services/backoffice.js';

export type LeadRow = typeof leads.$inferSelect;

/** A lead as every sink receives it. The id is chosen before any sink runs, so they agree. */
export interface LeadRecord {
  id: string;
  createdAt: Date;
  client: ClientConfig;
  conversationId?: string;
  contact: { id?: string; name: string | null; waId: string };
  /** Request type from config (info, quote, sample, order) or `handoff`. */
  type: string;
  branchId: string;
  fields: Record<string, unknown>;
}

/** Somewhere a lead is written (WA-014). Throws on failure; the caller decides about retries. */
export interface LeadSink {
  readonly name: LeadSinkName;
  write(lead: LeadRecord): Promise<void>;
}

/**
 * Always on: the `leads` row, published to the back-office panel (which is WA-014's
 * MockLeadSink: the panel shows every lead the moment it is stored).
 */
export class DbLeadSink implements LeadSink {
  readonly name = 'db';

  constructor(
    private readonly db: Db,
    private readonly backoffice?: BackofficeService,
  ) {}

  async write(lead: LeadRecord): Promise<void> {
    await this.insert(lead);
  }

  async insert(lead: LeadRecord): Promise<LeadRow> {
    const [row] = await this.db
      .insert(leads)
      .values({
        id: lead.id,
        clientId: lead.client.id,
        conversationId: lead.conversationId,
        contactId: lead.contact.id,
        type: lead.type,
        branchId: lead.branchId,
        fields: lead.fields,
        createdAt: lead.createdAt,
      })
      .returning();
    this.backoffice?.publishLead(lead.client, lead.contact.waId, row!);
    return row!;
  }
}

/**
 * Writes a lead to the database, then to the client's other configured sinks in the background,
 * so a slow or failing spreadsheet never delays or fails the customer's reply.
 */
export class LeadSinks {
  private readonly dbSink: DbLeadSink;
  private readonly background: BackgroundTasks;

  constructor(
    private readonly deps: {
      db: Db;
      backoffice?: BackofficeService;
      /** Extra sinks by name; a client uses those its `lead.sinks` lists. */
      sinks?: LeadSink[];
      background?: BackgroundTasks;
    },
  ) {
    this.dbSink = new DbLeadSink(deps.db, deps.backoffice);
    this.background = deps.background ?? new BackgroundTasks();
  }

  async save(lead: Omit<LeadRecord, 'id' | 'createdAt'>): Promise<LeadRow> {
    const record: LeadRecord = { ...lead, id: randomUUID(), createdAt: new Date() };
    const row = await this.dbSink.insert(record);
    for (const name of lead.client.lead.sinks) {
      if (name === 'db') continue;
      const sink = this.deps.sinks?.find((s) => s.name === name);
      if (!sink) {
        console.warn(`[leads] client "${lead.client.id}" uses sink "${name}", not configured`);
        continue;
      }
      this.background.run(`${name} lead ${record.id}`, () => sink.write(record));
    }
    return row;
  }

  flush(): Promise<void> {
    return this.background.flush();
  }
}
