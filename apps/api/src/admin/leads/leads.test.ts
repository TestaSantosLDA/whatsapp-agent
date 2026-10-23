import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AdminLeadDetail, AdminLeadList, ClientConfig } from '@wa/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeResponder } from '../../agent/claude-responder.js';
import { agentTools } from '../../agent/registry.js';
import { contacts, leadEvents, leads, outbox } from '../../db/schema.js';
import { LeadReminders } from '../../leads/reminders.js';
import { DbLeadSink } from '../../leads/sink.js';
import { OutboxMailer } from '../../mail/mailer.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { adminTestApp } from '../../test/admin.js';
import { testClient } from '../../test/helpers.js';
import { csvCell, csvPhone, toCsv } from './csv.js';

const weekday = ['09:00-13:00', '14:00-18:00'];
const office = { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday };
const base = testClient().branches[0]!;
const acme = testClient({
  branches: [
    { ...base, id: 'lisboa', name: 'Lisboa', hours: office, lead_emails: ['lx@example.invalid'] },
    { ...base, id: 'porto', name: 'Porto', region: 'Norte', hours: office },
    { ...base, id: 'faro', name: 'Faro', region: 'Algarve', hours: office },
  ],
  lead: {
    request_types: ['info', 'quote'],
    response_time: 'um dia útil',
    response_time_hours: 8,
  } as ClientConfig['lead'],
});
const beta = testClient({
  id: 'beta',
  name: 'Beta Lda',
  channel: { type: 'simulator', phone_number_id: 'beta-phone', display_phone_number: '+351 1' },
});

type T = Awaited<ReturnType<typeof adminTestApp>>;
let current: T | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

async function setup() {
  const t = await adminTestApp({ clients: [acme, beta] });
  current = t;
  const sink = new DbLeadSink(t.db);
  /** A lead as the agent saves it, owner picked by the policy. */
  const lead = async (o: {
    branchId: string;
    createdAt?: Date;
    type?: string;
    fields?: Record<string, unknown>;
    waId?: string;
    name?: string;
    client?: ClientConfig;
  }) => {
    const client = o.client ?? acme;
    const waId = o.waId ?? `3519${Math.floor(Math.random() * 1e8)}`;
    const [contact] = await t.db
      .insert(contacts)
      .values({ clientId: client.id, waId, name: o.name ?? 'Ana' })
      .returning();
    return sink.insert({
      id: randomUUID(),
      createdAt: o.createdAt ?? new Date(),
      client,
      contact: { id: contact!.id, name: contact!.name, waId },
      type: o.type ?? 'quote',
      branchId: o.branchId,
      fields: o.fields ?? { summary: 'Deck de 30 m²' },
    });
  };
  const json = async <R>(res: Response | Promise<Response>, status = 200): Promise<R> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as R;
  };
  return { ...t, lead, json };
}

const url = (path = '') => `/api/admin/clients/acme/leads${path}`;

describe('lead owners', () => {
  it('round robins among the branch sales members, then admins, else nobody', async () => {
    const t = await setup();
    const [a, b, c] = await t.team.ensure('acme', [
      { email: 'a@example.invalid', role: 'sales', branches: ['lisboa'] },
      { email: 'b@example.invalid', role: 'sales', branches: ['lisboa', 'porto'] },
      { email: 'c@example.invalid', role: 'sales', branches: ['lisboa'] },
    ]);
    const [boss] = await t.team.ensure('acme', [
      { email: 'boss@example.invalid', role: 'admin', branches: ['faro'] },
    ]);
    await t.team.ensure('acme', [{ email: 'everyone@example.invalid', role: 'admin' }]);

    const owners: (string | null)[] = [];
    const start = Date.parse('2026-10-06T09:00:00Z');
    for (let i = 0; i < 4; i++) {
      const row = await t.lead({ branchId: 'lisboa', createdAt: new Date(start + i * 60_000) });
      owners.push(row.ownerMemberId);
    }
    expect(owners).toEqual([a!.id, b!.id, c!.id, a!.id]);

    // Porto's only sales member is b; Faro has no sales, so its admin; Beta has nobody.
    expect((await t.lead({ branchId: 'porto' })).ownerMemberId).toBe(b!.id);
    expect((await t.lead({ branchId: 'faro' })).ownerMemberId).toBe(boss!.id);
    expect((await t.lead({ branchId: 'lisboa', client: beta })).ownerMemberId).toBeNull();

    // A new member is next in line: they have no leads yet.
    const [d] = await t.team.ensure('acme', [
      { email: 'd@example.invalid', role: 'sales', branches: ['lisboa'] },
    ]);
    expect((await t.lead({ branchId: 'lisboa' })).ownerMemberId).toBe(d!.id);

    const [created] = await t.db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.kind, 'created'))
      .orderBy(asc(leadEvents.createdAt))
      .limit(1);
    expect(created!.data).toMatchObject({ owner: a!.id, rule: 'round_robin' });
  });
});

describe('leads API', () => {
  it('scopes leads to the member’s branches and the client', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
    const porto = await t.member('acme', {
      email: 'p@example.invalid',
      role: 'sales',
      branches: ['porto'],
    });
    const lx = await t.lead({ branchId: 'lisboa', name: 'Lia' });
    const pt = await t.lead({ branchId: 'porto', name: 'Paulo' });
    const other = await t.lead({ branchId: 'lisboa', client: beta });

    const all = await t.json<AdminLeadList>(t.call(url(), admin.token));
    expect(all.items.map((i) => i.id).sort()).toEqual([lx.id, pt.id].sort());
    const mine = await t.json<AdminLeadList>(t.call(url(), porto.token));
    expect(mine.items.map((i) => i.id)).toEqual([pt.id]);
    expect(mine.total).toBe(1);
    // Asking for another branch does not widen the scope.
    expect((await t.json<AdminLeadList>(t.call(url('?branch=lisboa'), porto.token))).items).toEqual(
      [],
    );

    expect((await t.call(url(`/${lx.id}`), porto.token)).status).toBe(403);
    expect(
      (
        await t.call(url(`/${lx.id}/status`), porto.token, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'contacted' }),
        })
      ).status,
    ).toBe(403);
    expect((await t.call(url(`/${other.id}`), admin.token)).status).toBe(404);
    expect((await t.call(url('/not-a-uuid'), admin.token)).status).toBe(404);
    const csv = await (await t.call(url('/export.csv'), porto.token)).text();
    expect(csv).toContain('Paulo');
    expect(csv).not.toContain('Lia');
  });

  it('filters by branch, type, status, owner and search', async () => {
    const t = await setup();
    const sales = await t.member('acme', {
      email: 's@example.invalid',
      role: 'sales',
      branches: ['lisboa'],
    });
    const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
    const deck = await t.lead({
      branchId: 'lisboa',
      name: 'Rita Sousa',
      waId: '351912345678',
      fields: { products: 'Deck de pinho', summary: 'Varanda' },
    });
    const order = await t.lead({
      branchId: 'porto',
      type: 'order',
      fields: { items: [{ title: 'Pavimento de carvalho', variant: '12 mm' }] },
    });
    const handoff = await t.lead({ branchId: 'faro', type: 'handoff', fields: {} });
    const ids = async (query: string) =>
      (await t.json<AdminLeadList>(t.call(url(query), admin.token))).items.map((i) => i.id);

    expect(await ids('?branch=porto,faro')).toEqual([handoff.id, order.id]);
    expect(await ids('?type=order,handoff')).toEqual([handoff.id, order.id]);
    expect(await ids('?q=rita')).toEqual([deck.id]);
    expect(await ids('?q=pinho')).toEqual([deck.id]);
    expect(await ids('?q=carvalho')).toEqual([order.id]);
    expect(await ids('?q=912 345')).toEqual([deck.id]);
    expect(await ids('?owner=none')).toEqual([handoff.id, order.id]);
    expect(await ids(`?owner=${sales.row.id}`)).toEqual([deck.id]);
    expect(
      (await t.json<AdminLeadList>(t.call(url('?owner=me'), sales.token))).items.map((i) => i.id),
    ).toEqual([deck.id]);

    await t.call(url(`/${order.id}/status`), admin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'quoted' }),
    });
    expect(await ids('?status=quoted')).toEqual([order.id]);
    expect(await ids('?status=new')).toEqual([handoff.id, deck.id]);
    expect((await t.call(url('?status=nope'), admin.token)).status).toBe(400);
    expect((await t.call(url('?owner=x'), admin.token)).status).toBe(400);

    const list = await t.json<AdminLeadList>(t.call(url('?limit=1&offset=1'), admin.token));
    expect(list).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(list.items.map((i) => i.id)).toEqual([order.id]);
    const item = (await t.json<AdminLeadList>(t.call(url(), admin.token))).items.find(
      (i) => i.id === deck.id,
    )!;
    expect(item).toMatchObject({
      name: 'Rita Sousa',
      phone: '+351912345678',
      products: 'Deck de pinho',
      branchName: 'Lisboa',
      status: 'new',
      owner: { id: sales.row.id, email: 's@example.invalid' },
    });
  });

  it('moves a lead through the statuses and records who did what', async () => {
    const t = await setup();
    const ana = await t.member('acme', {
      email: 'ana@example.invalid',
      name: 'Ana',
      role: 'sales',
      branches: ['lisboa'],
    });
    const rui = await t.member('acme', {
      email: 'rui@example.invalid',
      name: 'Rui',
      role: 'sales',
      branches: ['lisboa'],
    });
    const outsider = await t.member('acme', {
      email: 'x@example.invalid',
      role: 'sales',
      branches: ['porto'],
    });
    const lead = await t.lead({
      branchId: 'lisboa',
      fields: {
        summary: 'Deck',
        attachments: [{ type: 'image', media_id: 'm1', message_id: 'w1', caption: 'planta' }],
      },
    });
    expect(lead.ownerMemberId).toBe(ana.row.id);
    const patch = (path: string, body: unknown, token = ana.token) =>
      t.call(url(`/${lead.id}${path}`), token, { method: 'PATCH', body: JSON.stringify(body) });

    let detail = await t.json<AdminLeadDetail>(patch('/status', { status: 'contacted' }));
    expect(detail.status).toBe('contacted');
    expect(detail.contactedAt).not.toBeNull();
    detail = await t.json<AdminLeadDetail>(patch('/status', { status: 'quoted' }));
    expect(detail.quotedAt).not.toBeNull();

    // Lost needs a reason from the list.
    const missing = await patch('/status', { status: 'lost' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      message: 'lostReason: Indique o motivo da perda.',
    });
    expect((await patch('/status', { status: 'lost', lostReason: 'whatever' })).status).toBe(400);
    detail = await t.json<AdminLeadDetail>(
      patch('/status', { status: 'lost', lostReason: 'price', note: 'Achou caro.' }),
    );
    expect(detail).toMatchObject({ status: 'lost', lostReason: 'price' });
    expect(detail.closedAt).not.toBeNull();
    // Reopened: the reason and the close go away, the first contact stays.
    detail = await t.json<AdminLeadDetail>(patch('/status', { status: 'won' }));
    expect(detail).toMatchObject({ status: 'won', lostReason: null });
    // The same status again changes nothing.
    await t.json<AdminLeadDetail>(patch('/status', { status: 'won' }));

    // Owner: only someone working with the branch (or an admin).
    expect((await patch('/owner', { ownerId: outsider.row.id })).status).toBe(400);
    detail = await t.json<AdminLeadDetail>(patch('/owner', { ownerId: rui.row.id }));
    expect(detail.owner).toMatchObject({ id: rui.row.id, name: 'Rui' });
    detail = await t.json<AdminLeadDetail>(patch('/owner', { ownerId: null }));
    expect(detail.owner).toBeNull();

    const note = await t.json<{ id: string; body: string }>(
      t.call(url(`/${lead.id}/notes`), rui.token, {
        method: 'POST',
        body: JSON.stringify({ body: '  Ligar amanhã  ' }),
      }),
      201,
    );
    expect(note.body).toBe('Ligar amanhã');
    expect(
      (
        await t.call(url(`/${lead.id}/notes`), rui.token, {
          method: 'POST',
          body: JSON.stringify({ body: ' ' }),
        })
      ).status,
    ).toBe(400);

    detail = await t.json<AdminLeadDetail>(t.call(url(`/${lead.id}`), ana.token));
    expect(detail.notes.map((n) => [n.body, n.author?.email])).toEqual([
      ['Achou caro.', 'ana@example.invalid'],
      ['Ligar amanhã', 'rui@example.invalid'],
    ]);
    expect(detail.attachments).toEqual([
      { type: 'image', mediaId: 'm1', messageId: 'w1', caption: 'planta' },
    ]);
    expect(detail.owners.map((o) => o.email)).toEqual([
      'ana@example.invalid',
      'rui@example.invalid',
    ]);
    // Newest first.
    expect(detail.events.map((e) => [e.kind, e.actor?.email ?? null, e.data]).reverse()).toEqual([
      ['created', null, expect.objectContaining({ owner: ana.row.id, rule: 'round_robin' })],
      ['status', 'ana@example.invalid', { from: 'new', to: 'contacted' }],
      ['status', 'ana@example.invalid', { from: 'contacted', to: 'quoted' }],
      [
        'status',
        'ana@example.invalid',
        { from: 'quoted', to: 'lost', lostReason: 'price', noteId: detail.notes[0]!.id },
      ],
      ['status', 'ana@example.invalid', { from: 'lost', to: 'won' }],
      [
        'owner',
        'ana@example.invalid',
        expect.objectContaining({ from: ana.row.id, to: rui.row.id }),
      ],
      ['owner', 'ana@example.invalid', expect.objectContaining({ from: rui.row.id, to: null })],
      ['note', 'rui@example.invalid', expect.objectContaining({ noteId: note.id })],
    ]);
  });

  it('exports CSV for Excel: BOM, semicolons, CRLF, quoting and filters', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
    await t.lead({
      branchId: 'lisboa',
      createdAt: new Date('2026-10-06T13:05:00Z'),
      name: 'João "Jó" Simões',
      waId: '351912345678',
      fields: { summary: 'Deck; 30 m²\nurgente', location: 'Sintra', email: 'j@example.pt' },
    });
    await t.lead({ branchId: 'porto', type: 'info', fields: { summary: '=HYPERLINK("x")' } });

    const res = await t.call(url('/export.csv?branch=lisboa'), admin.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="pedidos-acme-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Data;Tipo;Estado;Motivo da perda;Filial;Responsável;Cliente;Telefone;Email;Localidade;Produtos;Resumo;Contactado em;ID',
    );
    expect(lines[1]).toMatch(
      /^06\/10\/2026 14:05;Orçamento;Novo;;Lisboa;;"João ""Jó"" Simões";912 345 678;j@example\.pt;Sintra;;"Deck; 30 m²\nurgente";;[0-9a-f-]{36}$/,
    );
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(3);

    const all = await (await t.call(url('/export.csv'), admin.token)).text();
    expect(all).toContain(`;"'=HYPERLINK(""x"")";`);
  });
});

describe('csv helpers', () => {
  it('quotes, neutralises formulas and formats phones', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('+351 91')).toBe("'+351 91");
    expect(csvCell('-3')).toBe("'-3");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(
      toCsv([
        ['a', 'b'],
        ['c', null],
      ]),
    ).toBe('﻿a;b\r\nc;\r\n');
    expect(csvPhone('+351 912 345 678')).toBe('912 345 678');
    expect(csvPhone('447700900123')).toBe('+447700900123');
    expect(csvPhone(null)).toBe('');
  });
});

describe('no-reply reminders', () => {
  const friday = new Date('2026-10-09T16:30:00Z'); // Friday 17:30 in Lisbon
  const lisbon = (iso: string) => new Date(`${iso}+01:00`);

  async function reminders(t: Awaited<ReturnType<typeof setup>>) {
    return new LeadReminders({
      db: t.db,
      clients: t.clients,
      mailer: new OutboxMailer({ db: t.db }),
      dashboardUrl: 'https://wa.example/admin/',
    });
  }
  const emails = (t: T) => t.db.select().from(outbox).orderBy(asc(outbox.createdAt));

  it('emails the owner after 8 working hours (Monday 17:30), then the admins after 24', async () => {
    const t = await setup();
    const [owner] = await t.team.ensure('acme', [
      { email: 'owner@example.invalid', name: 'Olga', role: 'sales', branches: ['lisboa'] },
    ]);
    await t.team.ensure('acme', [
      { email: 'lx-admin@example.invalid', role: 'admin', branches: ['lisboa'] },
      { email: 'porto-admin@example.invalid', role: 'admin', branches: ['porto'] },
    ]);
    const lead = await t.lead({ branchId: 'lisboa', createdAt: friday, name: 'Carla' });
    expect(lead.ownerMemberId).toBe(owner!.id);
    const job = await reminders(t);

    expect(await job.run(lisbon('2026-10-12T17:29'))).toEqual({ checked: 1, owner: 0, admin: 0 });
    expect(await job.run(lisbon('2026-10-12T17:30'))).toEqual({ checked: 1, owner: 1, admin: 0 });
    expect(await job.run(lisbon('2026-10-13T09:00'))).toEqual({ checked: 1, owner: 0, admin: 0 });
    let sent = await emails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'lead_reminder', to: ['owner@example.invalid'] });
    expect(sent[0]!.subject).toBe('Pedido sem resposta: Carla (Orçamento)');
    expect(sent[0]!.body).toContain('8 horas úteis');
    expect(sent[0]!.body).toContain(`https://wa.example/admin/leads/${lead.id}`);

    // 0.5 Friday + 8 Monday + 8 Tuesday + 7.5 Wednesday = 24 at Wednesday 17:30.
    expect(await job.run(lisbon('2026-10-14T17:29'))).toMatchObject({ admin: 0 });
    // Two runs at once (overlapping scheduler calls) still send one email.
    const both = await Promise.all([
      job.run(lisbon('2026-10-14T17:30')),
      job.run(lisbon('2026-10-14T17:31')),
    ]);
    expect(both.map((r) => r.admin).sort()).toEqual([0, 1]);
    expect(await job.run(lisbon('2026-10-20T10:00'))).toEqual({ checked: 0, owner: 0, admin: 0 });
    sent = await emails(t);
    expect(sent.map((e) => e.to)).toEqual([
      ['owner@example.invalid'],
      ['lx-admin@example.invalid'],
    ]);
    expect(sent[1]!.body).toContain('Responsável: Olga');

    const [row] = await t.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.ownerRemindedAt).toEqual(lisbon('2026-10-12T17:30'));
    expect(row!.adminRemindedAt).not.toBeNull();
    const kinds = await t.db
      .select({ kind: leadEvents.kind })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead.id))
      .orderBy(asc(leadEvents.createdAt));
    expect(kinds.map((k) => k.kind)).toEqual(['created', 'reminder_owner', 'reminder_admin']);
  });

  it('never reminds about a lead someone answered', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
    const lead = await t.lead({ branchId: 'lisboa', createdAt: friday });
    await t.call(url(`/${lead.id}/status`), admin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'contacted' }),
    });
    const job = await reminders(t);
    expect(await job.run(lisbon('2026-10-20T10:00'))).toEqual({ checked: 0, owner: 0, admin: 0 });
    expect(await emails(t)).toHaveLength(0);
  });

  it('without an owner or admins, reminds the branch’s lead recipients', async () => {
    const t = await setup();
    await t.lead({ branchId: 'lisboa', createdAt: friday });
    const job = await reminders(t);
    expect(await job.run(lisbon('2026-10-15T09:00'))).toMatchObject({ owner: 1, admin: 1 });
    expect((await emails(t)).map((e) => e.to)).toEqual([
      ['lx@example.invalid'],
      ['lx@example.invalid'],
    ]);
  });

  it('runs from POST /jobs/lead-reminders behind JOBS_SECRET', async () => {
    const t = await adminTestApp({
      clients: [acme],
      env: { JOBS_SECRET: 'jobs-secret-for-tests' },
    });
    current = t;
    expect((await t.app.request('/jobs/lead-reminders', { method: 'POST' })).status).toBe(401);
    const res = await t.app.request('/jobs/lead-reminders', {
      method: 'POST',
      headers: { 'x-jobs-secret': 'jobs-secret-for-tests' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 0, owner: 0, admin: 0 });
  });
});

describe('a lead saved by the agent', () => {
  it('gets an owner, then reminds the owner and later the admin', async () => {
    // Claude saves a quote request, then answers.
    const replies = [
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'save_lead',
            input: { request_type: 'quote', summary: 'Deck de 30 m².', location: 'Lisboa' },
          },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Registado.' }], stop_reason: 'end_turn' },
    ];
    let calls = 0;
    const anthropic = new Anthropic({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: async () =>
        Response.json({
          id: `msg_${calls}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          ...replies[calls++],
        }),
    });
    const client = { ...acme, tools: ['save_lead'] } as ClientConfig;
    const lazy: Responder = {
      respond: (input) => responder.respond(input),
      invalidate: (id) => responder.invalidate(id),
    };
    const t = await adminTestApp({ clients: [client], responder: lazy });
    current = t;
    const responder = new ClaudeResponder({
      db: t.db,
      anthropic,
      tools: agentTools,
      backoffice: t.backoffice,
      now: () => new Date('2026-10-09T16:30:00Z'),
    });
    const [owner] = await t.team.ensure('acme', [
      { email: 'vendas@example.invalid', role: 'sales', branches: ['lisboa'] },
    ]);
    await t.team.ensure('acme', [
      { email: 'chefe@example.invalid', role: 'admin', branches: ['lisboa'] },
    ]);

    // Friday 17:30 in Lisbon.
    vi.useFakeTimers({ now: new Date('2026-10-09T16:30:00Z'), toFake: ['Date'] });
    await t.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '351911111111', name: 'Ana', text: 'Queria um orçamento' }),
    });
    await t.queue.drain();
    vi.useRealTimers();

    const [lead] = await t.db.select().from(leads);
    expect(lead).toMatchObject({ ownerMemberId: owner!.id, status: 'new', branchId: 'lisboa' });
    const before = (await t.db.select().from(outbox)).length;
    const job = t.leadReminders;
    await job.run(new Date('2026-10-12T16:30:00Z')); // Monday 17:30: 8 working hours
    await job.run(new Date('2026-10-14T16:30:00Z')); // Wednesday 17:30: 24
    const reminders = (await t.db.select().from(outbox).orderBy(asc(outbox.createdAt))).slice(
      before,
    );
    expect(reminders.map((e) => [e.kind, e.to])).toEqual([
      ['lead_reminder', ['vendas@example.invalid']],
      ['lead_reminder', ['chefe@example.invalid']],
    ]);
  });
});
