import Anthropic from '@anthropic-ai/sdk';
import type {
  AdminLeadDetail,
  ClientConfig,
  GapsView,
  OverviewProductsView,
  OverviewView,
} from '@wa/shared';
import { and, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeResponder, type ToolCallRecord } from '../../agent/claude-responder.js';
import { agentRuns, leads, messages, outbox, quotes } from '../../db/schema.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { adminTestApp } from '../../test/admin.js';
import { seedCatalogue, shopClient, V } from '../../test/catalogue.js';
import { agentTools } from '../../agent/registry.js';
import { emptySearches, isDeferral, OTHER_TOPIC, searchFoundNothing, topicOf } from './gaps.js';
import { localDay, median, startOfMonth, startOfWeek } from './service.js';
import { formatMinutes } from './weekly.js';

const TZ = 'Europe/Lisbon';

describe('periods', () => {
  it('starts weeks on Monday and months on the 1st, at local midnight, across DST', () => {
    // Wednesday 21 Oct 2026, summer time (UTC+1).
    const wed = new Date('2026-10-21T10:00:00Z');
    expect(startOfWeek(wed, TZ).toISOString()).toBe('2026-10-18T23:00:00.000Z');
    expect(startOfMonth(wed, TZ).toISOString()).toBe('2026-09-30T23:00:00.000Z');
    // Monday 26 Oct, the day after the change to winter time (UTC+0).
    expect(startOfWeek(new Date('2026-10-26T00:30:00Z'), TZ).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
    // Sunday 25 Oct 23:30 local is still the week of the 19th.
    expect(startOfWeek(new Date('2026-10-25T23:30:00Z'), TZ).toISOString()).toBe(
      '2026-10-18T23:00:00.000Z',
    );
    // A week that starts in the previous month.
    expect(startOfWeek(new Date('2026-10-01T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-09-27T23:00:00.000Z',
    );
    expect(localDay(new Date('2026-10-18T23:00:00Z'), TZ)).toBe('2026-10-19');
  });

  it('medians and durations', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(135)).toBe('2 h 15 min');
  });
});

describe("couldn't answer signals", () => {
  it('recognises the agent deferring to a colleague, not a handoff message', () => {
    expect(
      isDeferral('Não tenho essa informação. Vou confirmar com um colega e já lhe digo.'),
    ).toBe(true);
    expect(isDeferral('Posso verificar isso com a equipa da Maia.')).toBe(true);
    expect(isDeferral("I'll check with a colleague and get back to you.")).toBe(true);
    expect(isDeferral('Lo confirmaré con un compañero.')).toBe(true);
    expect(isDeferral('Um colega de Lisboa vai responder aqui em breve.')).toBe(false);
    expect(isDeferral('O deck custa 54,90 €.')).toBe(false);
    expect(isDeferral(null)).toBe(false);
  });

  it('finds empty searches unless another search in the turn found something', () => {
    const call = (
      name: string,
      output: unknown,
      input: unknown = { query: 'x' },
    ): ToolCallRecord => ({
      name,
      input,
      ok: true,
      output: JSON.stringify(output),
      ms: 1,
    });
    const none = call('search_products', { count: 0, results: [] }, { query: 'telha' });
    const some = call('search_products', { count: 2, results: [{}, {}] });
    const noDoc = call('search_documents', { results: [], note: '…' });
    expect(searchFoundNothing(none)).toBe(true);
    expect(searchFoundNothing(some)).toBe(false);
    expect(searchFoundNothing(noDoc)).toBe(true);
    expect(searchFoundNothing(call('get_product', {}))).toBeUndefined();
    expect(searchFoundNothing({ ...none, ok: false })).toBeUndefined();
    expect(emptySearches([none, noDoc])).toEqual([none, noDoc]);
    expect(emptySearches([none, some, noDoc])).toEqual([noDoc]);
  });

  it('groups by the most specific product type, else a theme, else "Outros"', () => {
    const types = ['Deck', 'Pavimento Vinílico', 'Pavimento de Madeira Maciça', 'Óleo'];
    expect(topicOf('Qual o espaçamento das vigas dos decks?', types)).toBe('Deck');
    expect(topicOf('O pavimento vinílico aguenta água?', types)).toBe('Pavimento Vinílico');
    expect(topicOf('pavimento de madeira maciça de carvalho', types)).toBe(
      'Pavimento de Madeira Maciça',
    );
    expect(topicOf('Que óleos têm?', types)).toBe('Óleo');
    expect(topicOf('Fazem entregas no Algarve?', types)).toBe('Entregas e transporte');
    expect(topicOf('Como se instala?', types)).toBe('Instalação e manutenção');
    expect(topicOf('Olá, bom dia', types)).toBe(OTHER_TOPIC);
  });
});

// ---------- end to end: the agent plays conversations, the overview counts them ----------

type Step = () => Record<string, unknown>;
const say =
  (text: string): Step =>
  () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const use =
  (name: string, input: unknown): Step =>
  () => ({
    content: [
      { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input },
    ],
    stop_reason: 'tool_use',
  });

function fakeClaude(script: Step[]) {
  let n = 0;
  return new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async () => {
      const step = script[n++];
      if (!step) throw new Error(`unexpected request #${n}`);
      return Response.json({
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
        ...step(),
      });
    },
  });
}

const base = shopClient().branches[0]!;
const weekday = ['09:00-13:00', '14:00-18:00'];
const office = { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday };
const acme = shopClient({
  timezone: TZ,
  branches: [
    { ...base, id: 'lisboa', name: 'Lisboa', hours: office },
    { ...base, id: 'porto', name: 'Porto', region: 'Norte', hours: office },
  ],
  routing: { default_branch: 'lisboa' },
  tools: ['search_products', 'get_product', 'show_products', 'save_lead', 'search_documents'],
} as Partial<ClientConfig>);

type T = Awaited<ReturnType<typeof adminTestApp>>;
let current: T | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

/** Wednesday 21 Oct 2026, 11:00 in Lisbon. */
const WED = new Date('2026-10-21T10:00:00Z');

async function playDemo(env: Record<string, string> = {}) {
  const script: Step[] = [
    // A: a product the store does not sell; the agent defers.
    use('search_products', { query: 'telha cerâmica' }),
    say('De momento não temos telhas no catálogo. Vou confirmar com um colega se conseguimos.'),
    // B: a product found, looked up and shown; then a quote request.
    use('search_products', { query: 'deck ipê' }),
    use('get_product', { variant_id: V.deck }),
    use('show_products', { variant_ids: [V.deck] }),
    say('O Deck de Ipê 21 mm está disponível.'),
    use('save_lead', { request_type: 'quote', summary: 'Deck de ipê, 30 m².', area_m2: 30 }),
    say('Registei o pedido de orçamento.'),
    // C: a technical question no document answers; handed over for lack of information.
    use('search_documents', { query: 'deck espaçamento vigas' }),
    use('handoff_to_human', {
      reason: 'could_not_help',
      summary: 'Pergunta o espaçamento das vigas do deck.',
    }),
    say('Um colega de Lisboa vai responder aqui.'),
    // D: asks for a person (a handoff, but not a gap).
    use('handoff_to_human', { reason: 'customer_asked', summary: 'Quer falar com uma pessoa.' }),
    say('Um colega vai responder aqui em breve.'),
  ];
  const anthropic = fakeClaude(script);
  const lazy: Responder = {
    respond: (input) => responder.respond(input),
    invalidate: (id) => responder.invalidate(id),
  };
  const t = await adminTestApp({ clients: [acme], responder: lazy, env });
  current = t;
  const responder = new ClaudeResponder({
    db: t.db,
    anthropic,
    tools: agentTools,
    backoffice: t.backoffice,
  });
  await seedCatalogue(t.db, acme);
  const admin = await t.member('acme', { email: 'chefe@example.invalid', role: 'admin' });
  const porto = await t.member('acme', {
    email: 'porto@example.invalid',
    role: 'sales',
    branches: ['porto'],
  });
  const lisboa = await t.member('acme', {
    email: 'lisboa@example.invalid',
    role: 'sales',
    branches: ['lisboa'],
  });

  vi.useFakeTimers({ now: WED, toFake: ['Date'] });
  const send = async (phone: string, text: string) => {
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await t.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, name: 'Cliente', text }),
    });
    await t.queue.drain();
  };
  await send('351910000001', 'Vendem telhas cerâmicas?');
  await send('351910000002', 'Quanto custa o deck de ipê?');
  await send('351910000002', 'Quero um orçamento para 30 m²');
  await send('351910000003', 'Qual o espaçamento das vigas do deck?');
  await send('351910000004', 'Queria falar com uma pessoa');
  // Periods end now and exclude their end: look a minute later.
  vi.setSystemTime(new Date(Date.now() + 60_000));

  const json = async <R>(res: Response | Promise<Response>, status = 200): Promise<R> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (r.status === 204 ? undefined : await r.json()) as R;
  };
  return { t, admin, porto, lisboa, json };
}

describe('overview after a demo run', () => {
  it('matches the database', async () => {
    const { t, admin, json } = await playDemo();
    const [quote] = await t.db.select().from(leads).where(eq(leads.type, 'quote'));
    expect(quote).toBeDefined();
    // The salesperson answers 90 minutes later and wins it.
    vi.setSystemTime(new Date(quote!.createdAt.getTime() + 90 * 60_000));
    await json<AdminLeadDetail>(
      t.call(`/api/admin/clients/acme/leads/${quote!.id}/status`, admin.token, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'contacted' }),
      }),
    );
    await json<AdminLeadDetail>(
      t.call(`/api/admin/clients/acme/leads/${quote!.id}/status`, admin.token, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'won' }),
      }),
    );
    vi.setSystemTime(new Date(Date.now() + 60_000));

    const view = await json<OverviewView>(t.call('/api/admin/clients/acme/overview', admin.token));
    const from = new Date(view.week.from);
    const to = new Date(view.week.to);
    expect(view.week.from).toBe('2026-10-18T23:00:00.000Z');
    expect(view.month.from).toBe('2026-09-30T23:00:00.000Z');

    // The same figures straight from the tables.
    const db = t.db;
    const [conv] = await db
      .select({ n: sql<number>`count(distinct ${messages.conversationId})::int` })
      .from(messages)
      .where(
        and(
          eq(messages.direction, 'inbound'),
          gte(messages.createdAt, from),
          lt(messages.createdAt, to),
        ),
      );
    const saved = await db.select().from(leads).where(ne(leads.type, 'handoff'));
    const handoffs = await db.select().from(leads).where(eq(leads.type, 'handoff'));
    const runs = await db.select().from(agentRuns);
    const cost = runs.reduce((s, r) => s + Number(r.costUsd ?? 0), 0);

    for (const period of [view.week, view.month]) {
      expect(period.conversations).toBe(conv!.n);
      expect(period.conversations).toBe(4);
      expect(period.leads).toBe(saved.length);
      expect(period.leadsByType).toEqual([{ key: 'quote', label: 'Orçamento', count: 1 }]);
      expect(period.handoffs).toBe(handoffs.length);
      expect(period.handoffs).toBe(2);
      expect(period.handoffsByReason.map((r) => [r.key, r.count]).sort()).toEqual([
        ['could_not_help', 1],
        ['customer_asked', 1],
      ]);
      expect(period.won).toBe(1);
      expect(period.lost).toBe(0);
      expect(period.quoted).toBe(0);
      expect(period.quotesSent).toBe(0);
      expect(period.firstResponse).toMatchObject({ answered: 1, medianMinutes: 90 });
      // Wednesday 11:0x to 12:3x, all inside opening hours.
      expect(period.firstResponse.medianWorkingMinutes).toBe(90);
      // Handoffs have an owner too and are still waiting.
      expect(period.firstResponse.waiting).toBe(2);
      expect(period.cost?.turns).toBe(runs.length);
      expect(period.cost?.turns).toBe(5);
      expect(period.cost?.agentUsd).toBeCloseTo(cost, 6);
      expect(period.cost?.agentUsd).toBeGreaterThan(0);
    }
    expect(view.branches).toEqual([
      {
        branchId: 'lisboa',
        name: 'Lisboa',
        week: { leads: 1, handoffs: 2, won: 1, lost: 0 },
        month: { leads: 1, handoffs: 2, won: 1, lost: 0 },
      },
      {
        branchId: 'porto',
        name: 'Porto',
        week: { leads: 0, handoffs: 0, won: 0, lost: 0 },
        month: { leads: 0, handoffs: 0, won: 0, lost: 0 },
      },
    ]);

    // Next week the old leads are out of "this week" but still in the month.
    vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
    const fresh = await t.member('acme', { email: 'chefe2@example.invalid', role: 'admin' });
    const later = await json<OverviewView>(t.call('/api/admin/clients/acme/overview', fresh.token));
    expect(later.week).toMatchObject({ conversations: 0, leads: 0, handoffs: 0, won: 0 });
    expect(later.month).toMatchObject({ conversations: 4, leads: 1, handoffs: 2, won: 1 });
  });

  it("counts quotes sent and the team's inbox replies, which are never gaps", async () => {
    const { t, admin, lisboa, porto, json } = await playDemo();
    const [asked] = await t.db
      .select()
      .from(leads)
      .where(sql`${leads.fields}->>'reason' = 'customer_asked'`);
    // Lisboa replies from the inbox 30 minutes after the handoff, in words that sound like the
    // agent deferring; the lead itself stays `new`.
    vi.setSystemTime(new Date(asked!.createdAt.getTime() + 30 * 60_000));
    const reply = await t.call(
      `/api/admin/clients/acme/inbox/${asked!.conversationId}/reply`,
      lisboa.token,
      {
        method: 'POST',
        body: JSON.stringify({ text: 'Bom dia! Vou confirmar com um colega e já lhe digo.' }),
      },
    );
    expect(reply.status).toBe(201);
    // Quotes: two sent this week (Lisboa, Porto), a draft, and one sent last month.
    const now = new Date();
    const quote = (n: string, o: Partial<typeof quotes.$inferInsert>) => ({
      clientId: 'acme',
      number: `ACME-2026-${n}`,
      validUntil: '2026-12-31',
      ...o,
    });
    await t.db.insert(quotes).values([
      quote('0001', { status: 'sent', sentAt: now, branchId: 'lisboa' }),
      quote('0002', { status: 'sent', sentAt: now, branchId: 'porto' }),
      quote('0003', { status: 'draft', branchId: 'lisboa' }),
      quote('0004', {
        status: 'sent',
        sentAt: new Date('2026-09-15T10:00:00Z'),
        branchId: 'lisboa',
      }),
    ]);
    vi.setSystemTime(new Date(Date.now() + 60_000));

    const view = await json<OverviewView>(t.call('/api/admin/clients/acme/overview', admin.token));
    for (const period of [view.week, view.month]) {
      expect(period.quotesSent).toBe(2);
      // The handoff answered from the inbox; the other handoff and the quote request still wait.
      expect(period.firstResponse).toMatchObject({ answered: 1, waiting: 2, medianMinutes: 30 });
    }
    const mine = await json<OverviewView>(t.call('/api/admin/clients/acme/overview', lisboa.token));
    expect(mine.week.quotesSent).toBe(1);
    const theirs = await json<OverviewView>(
      t.call('/api/admin/clients/acme/overview', porto.token),
    );
    expect(theirs.week).toMatchObject({ quotesSent: 1, firstResponse: { answered: 0 } });

    // The person's "vou confirmar com um colega" is not the agent deferring.
    const gaps = await json<GapsView>(t.call('/api/admin/clients/acme/overview/gaps', admin.token));
    expect(gaps.topics.flatMap((g) => g.examples.map((e) => e.question))).not.toContain(
      'Queria falar com uma pessoa',
    );
    expect(gaps.total).toBe(2);
  });

  it('lists what the agent could not answer, grouped by topic, and dismisses a topic', async () => {
    const { t, admin, lisboa, json } = await playDemo();
    const gaps = await json<GapsView>(t.call('/api/admin/clients/acme/overview/gaps', admin.token));
    expect(gaps.total).toBe(2);
    expect(gaps.topics.map((g) => g.topic).sort()).toEqual(['Deck', OTHER_TOPIC]);
    const deck = gaps.topics.find((g) => g.topic === 'Deck')!;
    expect(deck).toMatchObject({ count: 1, reasons: { deferred: 0, handoff: 1, no_result: 1 } });
    expect(deck.examples[0]).toMatchObject({
      question: 'Qual o espaçamento das vigas do deck?',
      reply: null,
    });
    expect(deck.examples[0]!.reasons.sort()).toEqual(['handoff', 'no_result']);
    const other = gaps.topics.find((g) => g.topic === OTHER_TOPIC)!;
    expect(other.reasons).toEqual({ deferred: 1, handoff: 0, no_result: 1 });
    expect(other.examples[0]).toMatchObject({
      question: 'Vendem telhas cerâmicas?',
      reply: expect.stringContaining('Vou confirmar com um colega'),
    });
    // The quote request, the product found and the request for a person are not gaps.
    const questions = gaps.topics.flatMap((g) => g.examples.map((e) => e.question));
    expect(questions).not.toContain('Quanto custa o deck de ipê?');
    expect(questions).not.toContain('Queria falar com uma pessoa');

    // Sales members do not see customers' questions here.
    expect((await t.call('/api/admin/clients/acme/overview/gaps', lisboa.token)).status).toBe(403);
    expect(
      (
        await t.call('/api/admin/clients/acme/overview/gaps/dismiss', lisboa.token, {
          method: 'POST',
          body: JSON.stringify({ topic: 'Deck' }),
        })
      ).status,
    ).toBe(403);

    await json(
      t.call('/api/admin/clients/acme/overview/gaps/dismiss', admin.token, {
        method: 'POST',
        body: JSON.stringify({ topic: 'Deck' }),
      }),
      204,
    );
    const after = await json<GapsView>(
      t.call('/api/admin/clients/acme/overview/gaps', admin.token),
    );
    expect(after.topics.map((g) => g.topic)).toEqual([OTHER_TOPIC]);
    expect(
      (
        await t.call('/api/admin/clients/acme/overview/gaps/dismiss', admin.token, {
          method: 'POST',
          body: JSON.stringify({ topic: '' }),
        })
      ).status,
    ).toBe(400);
  });

  it('shows the most asked products and the searches with no result', async () => {
    const { t, lisboa, json } = await playDemo();
    const view = await json<OverviewProductsView>(
      t.call('/api/admin/clients/acme/overview/products?days=7', lisboa.token),
    );
    expect(view.products).toEqual([
      { productId: expect.any(String), title: 'Deck de Ipê 21 mm', conversations: 1, mentions: 2 },
    ]);
    expect(view.missingSearches).toEqual([
      { query: 'telha cerâmica', searches: 1, conversations: 1, lastAt: expect.any(String) },
    ]);
    expect(
      (await t.call('/api/admin/clients/acme/overview/products?days=0', lisboa.token)).status,
    ).toBe(400);
  });

  it("scopes the figures to a salesperson's branches, without the cost", async () => {
    const { t, porto, lisboa, admin, json } = await playDemo();
    const portoView = await json<OverviewView>(
      t.call('/api/admin/clients/acme/overview', porto.token),
    );
    expect(portoView.week).toMatchObject({ conversations: 0, leads: 0, handoffs: 0, cost: null });
    expect(portoView.branches.map((b) => b.branchId)).toEqual(['porto']);
    const lisboaView = await json<OverviewView>(
      t.call('/api/admin/clients/acme/overview', lisboa.token),
    );
    // Conversations with a Lisboa lead: the quote and both handoffs.
    expect(lisboaView.week).toMatchObject({ conversations: 3, leads: 1, handoffs: 2, cost: null });
    expect(
      (await t.call('/api/admin/clients/acme/overview?branch=lisboa', porto.token)).status,
    ).toBe(403);
    expect((await t.call('/api/admin/clients/acme/overview?branch=nope', admin.token)).status).toBe(
      400,
    );
    const one = await json<OverviewView>(
      t.call('/api/admin/clients/acme/overview?branch=lisboa', admin.token),
    );
    expect(one).toMatchObject({ branch: 'lisboa', week: { conversations: 3, cost: null } });
    const convs = await t.db
      .selectDistinct({ id: leads.conversationId })
      .from(leads)
      .where(and(eq(leads.branchId, 'lisboa'), isNotNull(leads.conversationId)));
    expect(one.week.conversations).toBe(convs.length);
  });

  it("emails the admins last week's figures and top gaps on Monday, once", async () => {
    const { t } = await playDemo();
    const before = (await t.db.select().from(outbox)).length;
    // Monday 26 Oct 2026, 08:00 in Lisbon (winter time).
    const monday = new Date('2026-10-26T08:00:00Z');
    const results = await t.weeklyInsights.run(monday);
    expect(results).toEqual([{ clientId: 'acme', status: 'sent', recipients: 1 }]);
    expect(await t.weeklyInsights.run(monday)).toEqual([
      { clientId: 'acme', status: 'already_sent', recipients: 0 },
    ]);
    const emails = (await t.db.select().from(outbox)).slice(before);
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email).toMatchObject({ kind: 'weekly_insights', to: ['chefe@example.invalid'] });
    expect(email.subject).toBe('Resumo da semana 19/10 a 25/10: 1 pedidos, 2 passagens');
    expect(email.body).toContain('Conversas: 4');
    expect(email.body).toContain('Passagens para a equipa: 2');
    expect(email.body).toContain('Deck: 1 pergunta');
    expect(email.body).toContain('Vendem telhas cerâmicas?');
    expect(email.body).toContain('http://test.local/admin/overview');
  });

  it('runs from the jobs route', async () => {
    const { t, json } = await playDemo({ JOBS_SECRET: 'test-jobs-secret-123' });
    vi.setSystemTime(new Date('2026-10-26T08:00:00Z'));
    const post = (path: string) =>
      t.app.request(path, { method: 'POST', headers: { 'x-jobs-secret': 'test-jobs-secret-123' } });
    expect(await json(post('/jobs/weekly-insights?client=acme'))).toEqual({
      results: [{ clientId: 'acme', status: 'sent', recipients: 1 }],
    });
    expect((await post('/jobs/weekly-insights?client=nope')).status).toBe(404);
    expect((await t.app.request('/jobs/weekly-insights', { method: 'POST' })).status).toBe(401);
  });
});
