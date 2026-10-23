import Anthropic from '@anthropic-ai/sdk';
import type {
  PrivacyActionResult,
  PrivacyAuditEntry,
  PrivacyCustomer,
  PrivacyRequestView,
  PrivacyRetentionView,
  SimEvent,
} from '@wa/shared';
import { eq, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../bus.js';
import { ClaudeResponder } from '../agent/claude-responder.js';
import { agentRuns, contacts, conversations, leads, messages, outbox } from '../db/schema.js';
import * as schema from '../db/schema.js';
import type { Db } from '../db/index.js';
import type { Responder } from '../jobs/process-conversation.js';
import { agentTools } from '../agent/registry.js';
import { adminTestApp } from '../test/admin.js';
import { testClient } from '../test/helpers.js';
import { personalDataHandlers } from './handlers.js';
import { personalTables, tablesWithoutHandler } from './registry.js';
import { targetHash } from './service.js';

type Step = (body: Record<string, unknown>) => Record<string, unknown>;

/** Claude answering from a script; records the request bodies. */
function fakeClaude(script: Step[]) {
  const bodies: Record<string, unknown>[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const step = script[bodies.length - 1];
      if (!step) throw new Error(`unexpected request #${bodies.length}`);
      return Response.json({
        id: `msg_${bodies.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        ...step(body),
      });
    },
  });
  return { anthropic, bodies };
}

const say =
  (text: string): Step =>
  () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const callTool =
  (name: string, input: unknown): Step =>
  () => ({
    content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    stop_reason: 'tool_use',
  });

const JOBS_SECRET = 'test-jobs-secret-123';
const ANA = { phone: '351911222333', name: 'Ana Quintela', email: 'ana.quintela@example.invalid' };
const BRUNO = { phone: '351933444555', name: 'Bruno Sardinha' };
const client = testClient({ tools: ['save_lead'] });

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * The app with a scripted Claude: Ana asks for a quote (save_lead: a lead, an email, an agent
 * run with her details in the tool input), sends a photo, then asks for her data to be deleted.
 * Bruno, another customer, asks for a quote too and must be left untouched.
 */
async function setup(extra: Step[] = []) {
  const claude = fakeClaude([
    callTool('save_lead', {
      request_type: 'quote',
      name: ANA.name,
      email: ANA.email,
      area_m2: 30,
      business_line: 'wood',
      location: 'Lisboa',
      summary: `Deck de 30 m² para a casa de ${ANA.name}.`,
    }),
    say('Registado: a equipa contacta-a em um dia útil.'),
    callTool('save_lead', { request_type: 'info', summary: 'Pavimento flutuante.' }),
    say('Registado.'),
    ...extra,
  ]);
  const holder: { responder?: ClaudeResponder } = {};
  const lazy: Responder = {
    respond: (input) => holder.responder!.respond(input),
    invalidate: (id) => holder.responder!.invalidate(id),
  };
  const t = await adminTestApp({ clients: [client], responder: lazy, env: { JOBS_SECRET } });
  cleanup = async () => {
    await t.queue.drain();
    await t.close();
  };
  holder.responder = new ClaudeResponder({
    db: t.db,
    anthropic: claude.anthropic,
    tools: agentTools,
    backoffice: t.backoffice,
  });
  const send = async (who: { phone: string; name: string }, text: string) => {
    const res = await t.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: who.phone, name: who.name, text }),
    });
    expect(res.status).toBeLessThan(300);
    await t.queue.drain();
  };

  await send(ANA, `Olá, sou a ${ANA.name}. Queria um orçamento para um deck de 30 m².`);
  await send(BRUNO, 'Têm pavimento flutuante?');
  const [ana] = await t.db.select().from(contacts).where(eq(contacts.waId, ANA.phone));
  const [bruno] = await t.db.select().from(contacts).where(eq(contacts.waId, BRUNO.phone));
  // A photo she sent (media are referenced by WhatsApp id until they are stored).
  const [conv] = await t.db
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, ana!.id));
  await t.db.insert(messages).values({
    clientId: 'acme',
    conversationId: conv!.id,
    direction: 'inbound',
    channelMessageId: 'wamid.photo-1',
    type: 'image',
    text: `Foto do terraço da ${ANA.name}`,
    payload: {
      from: ANA.phone,
      type: 'image',
      image: { id: 'media-123', mime_type: 'image/jpeg', caption: 'O terraço' },
    },
    status: 'received',
  });
  const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
  const base = '/api/admin/clients/acme/privacy';
  const json = async <T>(path: string, init: RequestInit = {}) => {
    const res = await t.call(`${base}${path}`, admin.token, init);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as T;
  };
  return { t, claude, send, ana: ana!, bruno: bruno!, admin, base, json };
}

/** Every text, text[] and jsonb column of every table whose value contains one of `needles`. */
async function findAnywhere(db: Db, needles: string[]) {
  const hits: string[] = [];
  for (const table of (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
    is(v, PgTable),
  )) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const type = column.getSQLType();
      if (!(type.startsWith('text') || type === 'jsonb')) continue;
      for (const needle of needles) {
        const result = await db.execute(
          sql`select count(*)::int as n from ${sql.identifier(config.name)} where ${sql.identifier(column.name)}::text ilike ${`%${needle}%`}`,
        );
        const n = Number((result as unknown as { rows: { n: number }[] }).rows[0]!.n);
        if (n > 0) hits.push(`${config.name}.${column.name} ~ ${needle} (${n})`);
      }
    }
  }
  return hits;
}

const anaNeedles = [ANA.phone, ANA.phone.slice(3), ANA.name, 'Quintela', ANA.email];

describe('schema coverage', () => {
  it('every table linked to a contact or a conversation has a personal data handler', () => {
    expect(tablesWithoutHandler(schema, personalDataHandlers)).toEqual([]);
    const names = personalTables(schema).map((t) => getTableConfig(t).name);
    expect(names).toEqual(
      expect.arrayContaining(['contacts', 'conversations', 'messages', 'leads', 'outbox']),
    );
    expect(names).not.toContain('products');
  });

  it('reports a new table without a handler', () => {
    const notes = pgTable('lead_notes_example', {
      id: uuid('id').primaryKey(),
      contactId: uuid('contact_id'),
      body: text('body'),
    });
    const docs = pgTable('documents_example', {
      id: uuid('id').primaryKey(),
      ownerId: uuid('owner_id').references(() => contacts.id),
    });
    expect(tablesWithoutHandler({ ...schema, notes, docs }, personalDataHandlers)).toEqual([
      'lead_notes_example',
      'documents_example',
    ]);
  });
});

describe('privacy tools', () => {
  it('finds a customer and exports everything held about them as a ZIP', async () => {
    const { t, ana, json, base, admin } = await setup();
    const found = await json<PrivacyCustomer[]>(`/customers?q=${encodeURIComponent('quintela')}`);
    expect(found.map((c) => c.contactId)).toEqual([ana.id]);
    expect(found[0]).toMatchObject({ phone: ANA.phone, conversations: 1, leads: 1 });
    expect((await json<PrivacyCustomer[]>('/customers?q=911 222')).map((c) => c.phone)).toEqual([
      ANA.phone,
    ]);

    const res = await t.call(`${base}/customers/${ana.id}/export`, admin.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="dados-cliente-/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['data.json']);
    const doc = JSON.parse(strFromU8(files['data.json']!)) as {
      format: string;
      data: Record<string, unknown>;
    };
    expect(doc.format).toBe('whatsapp-agent/privacy-export@1');
    expect(Object.keys(doc.data).sort()).toEqual(personalDataHandlers.map((h) => h.name).sort());
    const data = doc.data as {
      contacts: { phone: string; name: string }[];
      conversations: unknown[];
      messages: { messages: { text: string }[]; media: { mediaId: string }[] };
      leads: { fields: Record<string, unknown> }[];
      emails: { body: string }[];
      agent_runs: { toolCalls: unknown }[];
    };
    expect(data.contacts).toEqual([expect.objectContaining({ phone: ANA.phone, name: ANA.name })]);
    expect(data.conversations).toHaveLength(1);
    // Her message, the reply and the photo, and none of Bruno's.
    const allMessages = await t.db
      .select()
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.contactId, ana.id));
    expect(data.messages.messages).toHaveLength(allMessages.length);
    expect(allMessages.length).toBe(3);
    expect(JSON.stringify(data.messages)).not.toContain('flutuante');
    expect(data.messages.media).toEqual([expect.objectContaining({ mediaId: 'media-123' })]);
    expect(data.leads).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ email: ANA.email }) }),
    ]);
    expect(data.emails).toHaveLength(1);
    expect(data.emails[0]!.body).toContain(ANA.name);
    expect(JSON.stringify(data.agent_runs)).toContain(ANA.email);

    const audit = await json<PrivacyAuditEntry[]>('/audit');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'export',
        actor: 'admin@example.invalid',
        targetHash: targetHash(ana.id),
      }),
    ]);
  });

  it('clears the profile: opts out of profiling, keeps the history', async () => {
    const { t, ana, json } = await setup();
    await json<PrivacyActionResult>(`/customers/${ana.id}/clear-profile`, { method: 'POST' });
    const [row] = await t.db.select().from(contacts).where(eq(contacts.id, ana.id));
    expect(row!.profilingOptOut).toBe(true);
    expect((await json<PrivacyCustomer>(`/customers/${ana.id}`)).conversations).toBe(1);
    expect((await json<PrivacyAuditEntry[]>('/audit'))[0]!.action).toBe('clear_profile');
  });

  it('deletes a customer after typed confirmation: nothing with their phone or name remains', async () => {
    const { t, ana, bruno, json, base, admin } = await setup();
    const leadsBefore = await t.db.select().from(leads).orderBy(leads.createdAt);
    const runsBefore = (await t.db.select().from(agentRuns)).length;
    expect(await findAnywhere(t.db, anaNeedles)).not.toEqual([]);

    const wrong = await t.call(`${base}/customers/${ana.id}/delete`, admin.token, {
      method: 'POST',
      body: JSON.stringify({ confirm: 'Ana' }),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('confirm_mismatch');

    const { counts } = await json<PrivacyActionResult>(`/customers/${ana.id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ confirm: ' ana quintela ' }),
    });
    expect(counts).toMatchObject({
      contacts: 1,
      conversations: 1,
      messages: 3,
      emails: 1,
      leads_anonymised: 1,
    });
    expect(counts.agent_runs_anonymised).toBeGreaterThan(0);

    expect(await findAnywhere(t.db, anaNeedles)).toEqual([]);

    // Leads are anonymised, so counts and stats stay right.
    const leadsAfter = await t.db.select().from(leads).orderBy(leads.createdAt);
    expect(leadsAfter).toHaveLength(leadsBefore.length);
    const anon = leadsAfter.find((l) => l.id === leadsBefore[0]!.id)!;
    expect(anon).toMatchObject({
      type: 'quote',
      branchId: leadsBefore[0]!.branchId,
      status: leadsBefore[0]!.status,
      createdAt: leadsBefore[0]!.createdAt,
      contactId: null,
      conversationId: null,
      fields: { request_type: 'quote', business_line: 'wood', area_m2: 30, anonymised: true },
    });
    expect((await t.db.select().from(agentRuns)).length).toBe(runsBefore);

    // Bruno is untouched.
    expect(await findAnywhere(t.db, [BRUNO.phone])).not.toEqual([]);
    expect((await json<PrivacyCustomer>(`/customers/${bruno.id}`)).leads).toBe(1);
    const brunoLead = leadsAfter.find((l) => l.contactId === bruno.id)!;
    expect(brunoLead.fields).toMatchObject({ summary: 'Pavimento flutuante.' });
    expect(await t.db.select().from(outbox)).toHaveLength(1);

    const [entry] = await json<PrivacyAuditEntry[]>('/audit');
    expect(entry).toMatchObject({ action: 'delete', counts });
    expect((await t.call(`${base}/customers/${ana.id}`, admin.token)).status).toBe(404);
  });

  it('is for admins only', async () => {
    const { t, base } = await setup();
    const sales = await t.member('acme', {
      email: 'vendas@example.invalid',
      role: 'sales',
      branches: ['lisboa'],
    });
    expect((await t.call(`${base}/customers`, sales.token)).status).toBe(403);
    expect((await t.call(`${base}/requests`, sales.token)).status).toBe(403);
  });
});

describe('a deletion request from WhatsApp', () => {
  it('appears in the dashboard and, once approved, is carried out and confirmed to the customer', async () => {
    const { t, claude, send, ana, json, base, admin } = await setup([
      say('Quer mesmo que apaguemos as suas conversas e os seus dados? Responda "sim".'),
      callTool('request_data_deletion', { request: 'delete', confirmed: true }),
      say('Pedido registado. Um administrador trata dele e avisamos aqui quando estiver feito.'),
    ]);
    await send(ANA, 'Apaguem os meus dados, por favor.');
    await send(ANA, 'Sim');
    const system = (claude.bodies.at(-1)!.system as { text: string }[])[0]!.text;
    expect(system).toContain('request_data_deletion');
    expect(JSON.stringify(claude.bodies.at(-1)!.messages)).toContain('request_id');

    const pending = await json<PrivacyRequestView[]>('/requests?status=pending');
    expect(pending).toEqual([
      expect.objectContaining({
        type: 'delete',
        source: 'whatsapp',
        status: 'pending',
        customer: { contactId: ana.id, name: ANA.name, phone: ANA.phone },
      }),
    ]);
    expect((await json<PrivacyCustomer>(`/customers/${ana.id}`)).pendingRequests).toBe(1);

    // Approving a delete needs the typed confirmation too.
    const unconfirmed = await t.call(`${base}/requests/${pending[0]!.id}/approve`, admin.token, {
      method: 'POST',
      body: '{}',
    });
    expect(unconfirmed.status).toBe(400);

    const seen: SimEvent[] = [];
    t.bus.subscribe(EventBus.key('acme', ANA.phone), (e) => seen.push(e));
    const result = await json<PrivacyActionResult>(`/requests/${pending[0]!.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ confirm: ANA.phone }),
    });
    expect(result.notified).toBe(true);
    expect(result.counts.contacts).toBe(1);
    const sent = seen.flatMap((e) => (e.type === 'message' ? [e.message] : []));
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('Os seus dados foram apagados');

    // The confirmation leaves no trace, and the request stays as a record without the person.
    expect(await findAnywhere(t.db, anaNeedles)).toEqual([]);
    const [done] = await json<PrivacyRequestView[]>('/requests');
    expect(done).toMatchObject({
      status: 'done',
      customer: null,
      decidedBy: 'admin@example.invalid',
      result: result.counts,
    });
    expect(await json<PrivacyRequestView[]>('/requests?status=pending')).toEqual([]);
    const again = await t.call(`${base}/requests/${done!.id}/approve`, admin.token, {
      method: 'POST',
      body: JSON.stringify({ confirm: ANA.phone }),
    });
    expect(again.status).toBe(409);
  });

  it('asking twice opens one request; a rejected one tells the customer', async () => {
    const { t, send, json } = await setup([
      callTool('request_data_deletion', { request: 'clear_profile', confirmed: true }),
      say('Pedido registado.'),
      callTool('request_data_deletion', { request: 'clear_profile', confirmed: true }),
      say('Já tinha registado o pedido.'),
    ]);
    await send(ANA, 'Não quero respostas personalizadas.');
    await send(ANA, 'Já pedi para não personalizarem.');
    const pending = await json<PrivacyRequestView[]>('/requests?status=pending');
    expect(pending).toHaveLength(1);
    const res = await json<PrivacyActionResult>(`/requests/${pending[0]!.id}/reject`, {
      method: 'POST',
    });
    expect(res.notified).toBe(true);
    const texts = (await t.db.select().from(messages)).map((m) => m.text ?? '');
    expect(texts.some((x) => x.includes('um colega vai contactá-lo'))).toBe(true);
    expect((await json<PrivacyAuditEntry[]>('/audit'))[0]!.action).toBe('request_rejected');
  });
});

describe('retention', () => {
  const monthsAgo = (months: number, plusDays = 0) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return new Date(d.getTime() + plusDays * 86_400_000);
  };

  it('lists who is due within 7 days and the job deletes those past the period', async () => {
    const { t, ana, bruno, json } = await setup();
    // Ana: 25 months without activity (past due). Bruno: due in 3 days.
    // Contacts are all old; what counts is their latest conversation.
    const age = async (contactId: string, at: Date) => {
      await t.db
        .update(contacts)
        .set({ createdAt: monthsAgo(30) })
        .where(eq(contacts.id, contactId));
      await t.db
        .update(conversations)
        .set({ lastActivityAt: at })
        .where(eq(conversations.contactId, contactId));
    };
    await age(ana.id, monthsAgo(25));
    await age(bruno.id, monthsAgo(24, 3));
    const fresh = await t.messages.upsertContact('acme', '351966000000', 'Carla');
    const dora = await t.messages.upsertContact('acme', '351966000001', 'Dora');
    await t.messages.openConversation('acme', dora.id);
    await t.db
      .update(contacts)
      .set({ createdAt: monthsAgo(30) })
      .where(eq(contacts.id, dora.id));

    const view = await json<PrivacyRetentionView>('/retention');
    expect(view).toMatchObject({ months: 24, days: 7 });
    expect(view.due.map((d) => d.contactId)).toEqual([ana.id, bruno.id]);
    expect(new Date(view.due[1]!.deleteOn).getTime()).toBeGreaterThan(Date.now());

    expect((await t.app.request('/jobs/privacy-retention', { method: 'POST' })).status).toBe(401);
    const res = await t.app.request('/jobs/privacy-retention', {
      method: 'POST',
      headers: { 'x-jobs-secret': JOBS_SECRET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ clientId: 'acme', ok: true, deleted: 1 }] });
    const left = (await t.db.select().from(contacts)).map((c) => c.id).sort();
    expect(left).toEqual([bruno.id, fresh.id, dora.id].sort());
    expect(await findAnywhere(t.db, anaNeedles)).toEqual([]);
    const [entry] = await json<PrivacyAuditEntry[]>('/audit');
    expect(entry).toMatchObject({ action: 'retention_delete', actor: null });
  });

  it('follows the client setting', async () => {
    const { t, ana } = await setup();
    const short = testClient({ tools: ['save_lead'], privacy: { retention_months: 1 } });
    await t.db
      .update(conversations)
      .set({ lastActivityAt: monthsAgo(2) })
      .where(eq(conversations.contactId, ana.id));
    await t.db
      .update(contacts)
      .set({ createdAt: monthsAgo(2) })
      .where(eq(contacts.id, ana.id));
    expect((await t.privacy.retentionDue(short)).due.map((d) => d.contactId)).toEqual([ana.id]);
    expect((await t.privacy.retentionDue(client)).due).toEqual([]);
  });
});
