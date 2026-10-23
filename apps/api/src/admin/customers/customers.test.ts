import Anthropic from '@anthropic-ai/sdk';
import type { ClientConfig, CustomerDetail, CustomerList, PrivacyActionResult } from '@wa/shared';
import { isSensitiveText, parseProfileValue } from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeResponder, type ToolCallRecord } from '../../agent/claude-responder.js';
import { agentTools } from '../../agent/registry.js';
import { mergeUsualProducts } from '../../customers/profile.js';
import {
  agentRuns,
  contacts,
  customerNotes,
  customerProfileFields,
  customers,
  leads,
  privacyAudit,
  quotes,
} from '../../db/schema.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { adminTestApp } from '../../test/admin.js';
import { testClient } from '../../test/helpers.js';

type Body = Record<string, unknown>;
type Step = (body: Body) => Body;

/** Claude answering from a script (a step may look at the request); records the bodies. */
function fakeClaude() {
  const bodies: Body[] = [];
  const script: Step[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      const step = script.shift();
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
  return { anthropic, bodies, script };
}

const say =
  (text: string): Step =>
  () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const callTool =
  (name: string, input: unknown): Step =>
  () => ({
    content: [
      { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input },
    ],
    stop_reason: 'tool_use',
  });

/** The turn's system message (customer context goes there, not into the cached prompt). */
const turnContextOf = (body: Body) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  return String([...msgs].reverse().find((m) => m.role === 'system')!.content);
};
const systemPromptOf = (body: Body) => (body.system as { text: string }[])[0]!.text;
const toolNames = (body: Body) => (body.tools as { name: string }[]).map((t) => t.name);

const CARLOS = { phone: '351912000111', name: 'Carlos Mendes' };
const acme = testClient({
  tools: ['save_lead'],
  profiling: { enabled: true },
  branches: [
    { ...testClient().branches[0]!, id: 'lisboa', name: 'Lisboa' },
    { ...testClient().branches[0]!, id: 'porto', name: 'Porto', region: 'Norte' },
  ],
});
const beta = testClient({
  id: 'beta',
  name: 'Beta Lda',
  channel: { type: 'simulator', phone_number_id: 'beta-phone', display_phone_number: '+351 1' },
  profiling: { enabled: true },
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(clients: ClientConfig[] = [acme, beta]) {
  const claude = fakeClaude();
  const holder: { responder?: ClaudeResponder } = {};
  const lazy: Responder = {
    respond: (input) => holder.responder!.respond(input),
    invalidate: (id) => holder.responder!.invalidate(id),
  };
  const t = await adminTestApp({ clients, responder: lazy });
  cleanup = async () => {
    await t.queue.drain();
    await t.close();
  };
  holder.responder = new ClaudeResponder({
    db: t.db,
    anthropic: claude.anthropic,
    tools: agentTools,
    backoffice: t.backoffice,
    now: () => new Date('2026-10-19T10:30:00Z'),
  });
  const send = async (who: { phone: string; name: string }, text: string, client = 'acme') => {
    const res = await t.app.request(`/sim/${client}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: who.phone, name: who.name, text }),
    });
    expect(res.status).toBeLessThan(300);
    await t.queue.drain();
  };
  const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
  const api = async <T>(
    path: string,
    init: RequestInit = {},
    status = 200,
    token = admin.token,
  ) => {
    const res = await t.call(`/api/admin/clients/acme/customers${path}`, token, init);
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const contactOf = async (phone: string, clientId = 'acme') => {
    const [row] = await t.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clientId, clientId), eq(contacts.waId, phone)));
    return row!;
  };
  const profile = async (customerId: string) =>
    t.db
      .select()
      .from(customerProfileFields)
      .where(eq(customerProfileFields.customerId, customerId));
  const lastCalls = async () => {
    const runs = await t.db.select().from(agentRuns).orderBy(agentRuns.createdAt);
    return runs.at(-1)!.toolCalls as ToolCallRecord[];
  };
  return { t, claude, send, admin, api, contactOf, profile, lastCalls };
}

/** The first conversation: an experienced carpenter who wants prices only. */
async function firstConversation(s: Awaited<ReturnType<typeof setup>>) {
  s.claude.script.push(
    callTool('note_profile', {
      detail_level: 'short',
      usual_products: [
        { name: 'Deck de pinho 21x145', variant_id: '4610001', quantity: '40 caixas' },
      ],
      job_types: ['decks'],
      evidence: 'só preciso do preço',
    }),
    say('Deck de pinho 21x145: 32,90 € por caixa, com IVA.'),
  );
  await s.send(
    CARLOS,
    'Bom dia, sou carpinteiro. Só preciso do preço, sem explicações: levo sempre 40 caixas do deck de pinho.',
  );
  const contact = await s.contactOf(CARLOS.phone);
  return { contact, customerId: contact.customerId! };
}

describe('profile values', () => {
  it('accepts only the listed fields and short factual values', () => {
    expect(parseProfileValue('detail_level', 'short')).toEqual({ ok: true, value: 'short' });
    expect(parseProfileValue('detail_level', 'very short').ok).toBe(false);
    expect(parseProfileValue('negotiates_on_volume', 'yes').ok).toBe(false);
    expect(parseProfileValue('job_types', ['decks', 'soalhos']).ok).toBe(true);
    expect(parseProfileValue('job_types', ['x'.repeat(41)]).ok).toBe(false);
    expect(parseProfileValue('job_types', ['decks\ne mais']).ok).toBe(false);
    expect(
      parseProfileValue('usual_products', [{ name: 'Deck', quantity: '40 m²', colour: 'x' }]).ok,
    ).toBe(false);
    for (const bad of [
      'é diabético',
      'cliente difícil',
      'muito chato',
      'Católico praticante',
      'divorciado',
      'rich guy',
      'é imigrante',
    ]) {
      expect([bad, isSensitiveText(bad)]).toEqual([bad, true]);
      expect(parseProfileValue('job_types', [bad]).ok).toBe(false);
    }
    for (const ok of ['Deck Ipê 21x145', 'Ricardo', 'louça sanitária', 'coberturas', '40 caixas']) {
      expect([ok, isSensitiveText(ok)]).toEqual([ok, false]);
    }
  });

  it('merges usual products, newest first, without repeats', () => {
    expect(
      mergeUsualProducts(
        [{ name: 'Deck pinho', variant_id: '1' }, { name: 'Óleo Osmo' }],
        [{ name: 'deck PINHO', variant_id: '1', quantity: '40 caixas' }, { name: 'oleo osmo' }],
      ),
    ).toEqual([
      { name: 'deck PINHO', variant_id: '1', quantity: '40 caixas' },
      { name: 'oleo osmo' },
    ]);
  });
});

describe('note_profile and the turn context', () => {
  it('notes allowed facts with the customer’s words, and uses them in the next conversation', async () => {
    const s = await setup();
    const { contact, customerId } = await firstConversation(s);
    expect(toolNames(s.claude.bodies[0]!)).toContain('note_profile');
    expect(systemPromptOf(s.claude.bodies[0]!)).toContain('# Customer profile');
    expect(systemPromptOf(s.claude.bodies[0]!)).not.toContain('Carlos');

    const rows = await s.profile(customerId);
    expect(rows.map((r) => [r.field, r.value, r.source, r.evidence]).sort()).toEqual([
      ['detail_level', 'short', 'agent', 'só preciso do preço'],
      ['job_types', ['decks'], 'agent', 'só preciso do preço'],
      [
        'usual_products',
        [{ name: 'Deck de pinho 21x145', variant_id: '4610001', quantity: '40 caixas' }],
        'agent',
        'só preciso do preço',
      ],
    ]);
    expect(rows.every((r) => r.conversationId)).toBe(true);

    // A new conversation; the team has his last order draft.
    await s.t.messages.closeConversation('acme', CARLOS.phone);
    await s.t.db.insert(leads).values({
      clientId: 'acme',
      contactId: contact.id,
      type: 'order',
      branchId: 'lisboa',
      fields: {
        items: [{ title: 'Deck de pinho', variant: '21x145', variant_id: '4610001', quantity: 40 }],
        fulfilment: 'delivery',
        delivery_address: 'Obra em Sintra',
      },
      createdAt: new Date('2026-10-01T09:00:00Z'),
    });
    // And a quote they sent him (WA-025); a draft is not the customer's yet.
    const line = { variantId: '4610001', sku: null, discountPercent: 0, vatPercent: 23 };
    await s.t.db.insert(quotes).values([
      {
        clientId: 'acme',
        contactId: contact.id,
        branchId: 'lisboa',
        number: 'ACME-2026-0001',
        status: 'sent',
        lines: [
          {
            ...line,
            description: 'Deck de pinho 21x145',
            quantity: 40,
            unit: 'cx',
            unitPrice: 26.748,
          },
        ],
        totalCents: 131600,
        validUntil: '2026-10-31',
        sentAt: new Date('2026-10-02T09:00:00Z'),
        createdAt: new Date('2026-10-02T08:00:00Z'),
      },
      {
        clientId: 'acme',
        contactId: contact.id,
        branchId: 'lisboa',
        number: 'ACME-2026-0002',
        lines: [{ ...line, description: 'Óleo para deck', quantity: 2, unit: 'un', unitPrice: 20 }],
        validUntil: '2026-11-30',
        createdAt: new Date('2026-10-03T08:00:00Z'),
      },
    ]);
    s.claude.script.push(say('40 caixas de deck de pinho 21x145, entrega em obra. Confirma?'));
    await s.send(CARLOS, 'Olá, o mesmo da última vez.');
    const context = turnContextOf(s.claude.bodies.at(-1)!);
    expect(context).toContain(
      "Customer's service preferences (adapt your replies to them; never mention that you keep them):",
    );
    expect(context).toContain('- detail_level: short (they said "só preciso do preço")');
    expect(context).toContain(
      '- usual_products: Deck de pinho 21x145 (variant 4610001), usually 40 caixas',
    );
    expect(context).toContain(
      '- 2026-10-01, order draft (status new, delivery to Obra em Sintra): Deck de pinho 21x145 (variant 4610001) × 40',
    );
    expect(context).toContain(
      '- 2026-10-02, quote ACME-2026-0001 sent by the team (total 1 316,00 € with VAT, valid until 2026-10-31): Deck de pinho 21x145 × 40 cx',
    );
    expect(context).not.toContain('ACME-2026-0002');
    expect(context.indexOf('ACME-2026-0001')).toBeLessThan(context.indexOf('2026-10-01, order'));
    // The cached system prompt stays the same for every customer.
    expect(systemPromptOf(s.claude.bodies.at(-1)!)).toBe(systemPromptOf(s.claude.bodies[0]!));

    // The dashboard shows the profile and why.
    const detail = await s.api<CustomerDetail>(`/${customerId}`);
    expect(detail.profile.state).toBe('on');
    expect(detail.profile.fields.find((f) => f.field === 'detail_level')).toMatchObject({
      value: 'short',
      source: 'agent',
      evidence: 'só preciso do preço',
      locked: false,
    });
    expect(detail.conversations).toHaveLength(2);
    expect(detail.conversations.map((c) => [c.status, c.messages, c.lastText])).toEqual([
      ['bot', 2, '40 caixas de deck de pinho 21x145, entrega em obra. Confirma?'],
      ['closed', 2, 'Deck de pinho 21x145: 32,90 € por caixa, com IVA.'],
    ]);
    expect(detail.leads).toEqual([
      expect.objectContaining({ type: 'order', products: 'Deck de pinho 21x145 × 40' }),
    ]);
    expect(detail.quotes.map((q) => [q.number, q.status, q.totalCents, q.branchName])).toEqual([
      ['ACME-2026-0002', 'draft', 0, 'Lisboa'],
      ['ACME-2026-0001', 'sent', 131600, 'Lisboa'],
    ]);
  });

  it('refuses anything but the listed fields, sensitive values and invented evidence', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    await s.t.db.delete(customerProfileFields);
    s.claude.script.push(
      callTool('note_profile', { mood: 'impaciente', evidence: 'Sou carpinteiro' }),
      callTool('note_profile', { price_tier: 'reseller', evidence: 'Sou carpinteiro' }),
      callTool('note_profile', { job_types: ['cliente difícil'], evidence: 'Sou carpinteiro' }),
      callTool('note_profile', { detail_level: 'short', evidence: 'tenho diabetes' }),
      callTool('note_profile', { detail_level: 'short', evidence: 'quer tudo rápido' }),
      callTool('note_profile', { evidence: 'Sou carpinteiro' }),
      say('Com certeza.'),
    );
    const before = s.claude.bodies.length;
    await s.send(CARLOS, 'Sou carpinteiro, é para uma obra em Sintra.');
    // Each call came back to Claude as an error result.
    const results = s.claude.bodies.slice(before + 1).map((b) => {
      const msgs = b.messages as { role: string; content: unknown }[];
      const user = [...msgs].reverse().find((m) => m.role === 'user')!;
      return (user.content as { type: string; is_error?: boolean; content?: unknown }[]).find(
        (c) => c.type === 'tool_result',
      )!;
    });
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.is_error)).toBe(true);
    // Unknown fields (mood, price_tier) and a judgement as a value never reach the tool: the
    // input schema is strict and runs the same guardrail as the dashboard.
    expect(JSON.stringify(results[0])).toMatch(/mood/);
    expect(JSON.stringify(results[1])).toMatch(/price_tier/);
    expect(JSON.stringify(results[2])).toMatch(/Only factual service preferences/);
    const calls = (await s.lastCalls()).filter((c) => c.name === 'note_profile');
    expect(calls.map((c) => c.error ?? '')).toEqual([
      expect.stringMatching(/not a service preference/),
      expect.stringMatching(/customer's own words/),
      expect.stringMatching(/at least one field/),
    ]);
    expect(await s.profile(customerId)).toEqual([]);
  });

  it('never overwrites a field the team set or locked', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    await s.api<CustomerDetail>(`/${customerId}/profile/detail_level`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'full' }),
    });
    await s.api<CustomerDetail>(`/${customerId}/profile/delivery`, {
      method: 'PUT',
      body: JSON.stringify({ locked: true }),
    });
    await s.api<CustomerDetail>(`/${customerId}/profile/job_types`, {
      method: 'PUT',
      body: JSON.stringify({ locked: true }),
    });

    s.claude.script.push(
      callTool('note_profile', {
        detail_level: 'short',
        delivery: 'site',
        job_types: ['coberturas'],
        technical_depth: 'technical',
        evidence: 'entrega na obra',
      }),
      say('Combinado.'),
    );
    await s.send(CARLOS, 'Preciso de entrega na obra, com a ficha técnica.');
    const [call] = (await s.lastCalls()).filter((c) => c.name === 'note_profile');
    expect(JSON.parse(call!.output!)).toEqual({
      ok: true,
      saved: ['technical_depth'],
      kept_by_team: ['detail_level', 'job_types', 'delivery'],
    });
    const rows = new Map((await s.profile(customerId)).map((r) => [r.field, r]));
    expect(rows.get('detail_level')).toMatchObject({
      value: 'full',
      source: 'team',
      evidence: null,
    });
    expect(rows.get('delivery')).toMatchObject({ value: null, locked: true });
    expect(rows.get('job_types')).toMatchObject({ value: ['decks'], locked: true });
    expect(rows.get('technical_depth')).toMatchObject({ value: 'technical', source: 'agent' });
    expect(turnContextOf(s.claude.bodies.at(-1)!)).toContain(
      'The team keeps these fields; do not note them: detail_level, job_types, delivery.',
    );

    // Unlocking an empty field removes it; the agent may then note it.
    await s.api(`/${customerId}/profile/delivery`, {
      method: 'PUT',
      body: JSON.stringify({ locked: false }),
    });
    expect((await s.profile(customerId)).some((r) => r.field === 'delivery')).toBe(false);
  });

  it('checks team edits too: field names, values and the guardrail', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    const put = (field: string, body: unknown, status: number) =>
      s.api<{ error: string; message: string }>(
        `/${customerId}/profile/${field}`,
        { method: 'PUT', body: JSON.stringify(body) },
        status,
      );
    expect((await put('mood', { value: 'calmo' }, 404)).error).toBe('unknown_field');
    expect((await put('detail_level', { value: 'médio' }, 400)).error).toBe('invalid_value');
    expect((await put('job_types', { value: ['cliente forreta'] }, 400)).message).toMatch(
      /Only factual service preferences/,
    );
    expect((await put('detail_level', {}, 400)).error).toBe('invalid_body');
    const ok = await s.api<CustomerDetail>(`/${customerId}/profile/price_tier`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'professional', locked: true }),
    });
    expect(ok.profile.fields.find((f) => f.field === 'price_tier')).toMatchObject({
      value: 'professional',
      source: 'team',
      locked: true,
      updatedBy: 'admin@example.invalid',
    });
    const removed = await s.api<CustomerDetail>(`/${customerId}/profile/job_types`, {
      method: 'DELETE',
    });
    expect(removed.profile.fields.map((f) => f.field)).not.toContain('job_types');
  });
});

describe('profiling off', () => {
  it('"clear profile" removes it, opts out, and the agent neither builds nor uses one', async () => {
    const s = await setup();
    const { contact, customerId } = await firstConversation(s);
    const cleared = await s.api<CustomerDetail>(`/${customerId}/profile/clear`, { method: 'POST' });
    expect(cleared.profile).toEqual({ state: 'opted_out', fields: [] });
    expect(await s.profile(customerId)).toEqual([]);
    expect((await s.contactOf(CARLOS.phone)).profilingOptOut).toBe(true);
    const [audit] = await s.t.db.select().from(privacyAudit);
    expect(audit).toMatchObject({ action: 'clear_profile', counts: { customer_profile: 3 } });
    expect(contact.id).toBeTruthy();

    s.claude.script.push(
      callTool('note_profile', { detail_level: 'short', evidence: 'só o preço' }),
      say('32,90 €.'),
    );
    await s.send(CARLOS, 'Quanto custa o deck? Só o preço.');
    const context = turnContextOf(s.claude.bodies.at(-2)!);
    expect(context).toContain('Profiling is off for this customer');
    expect(context).not.toContain('detail_level');
    const [call] = await s.lastCalls();
    expect(call).toMatchObject({ name: 'note_profile', ok: false });
    expect(call!.error).toMatch(/objected/);
    expect(await s.profile(customerId)).toEqual([]);

    const refused = await s.api<{ error: string }>(
      `/${customerId}/profile/detail_level`,
      { method: 'PUT', body: JSON.stringify({ value: 'short' }) },
      409,
    );
    expect(refused.error).toBe('profiling_opted_out');
    const list = await s.api<CustomerList>('');
    expect(list.items[0]!.profiling).toBe('opted_out');
  });

  it('the WhatsApp "clear profile" request (WA-028) runs the profile handler', async () => {
    const s = await setup();
    const { contact, customerId } = await firstConversation(s);
    const request = await s.t.privacy.openRequest('acme', contact.id, 'clear_profile');
    const res = await s.t.call(
      `/api/admin/clients/acme/privacy/requests/${request.request.id}/approve`,
      s.admin.token,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as PrivacyActionResult).counts).toEqual({ customer_profile: 3 });
    expect(await s.profile(customerId)).toEqual([]);
  });

  it('a client with profiling off gets no note_profile tool and no profile', async () => {
    const off = testClient({ tools: [] });
    const s = await setup([off]);
    s.claude.script.push(say('Olá!'));
    await s.send(CARLOS, 'Olá');
    expect(toolNames(s.claude.bodies[0]!)).not.toContain('note_profile');
    expect(systemPromptOf(s.claude.bodies[0]!)).not.toContain('# Customer profile');
    const { customerId } = await s
      .contactOf(CARLOS.phone)
      .then((c) => ({ customerId: c.customerId! }));
    const detail = await s.api<CustomerDetail>(`/${customerId}`);
    expect(detail.profile).toEqual({ state: 'disabled', fields: [] });
    const refused = await s.api<{ error: string }>(
      `/${customerId}/profile/detail_level`,
      { method: 'PUT', body: JSON.stringify({ value: 'short' }) },
      409,
    );
    expect(refused.error).toBe('profiling_disabled');
  });
});

describe('customer records in the dashboard', () => {
  it('lists, searches, edits a record and adds notes', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    s.claude.script.push(say('Olá Rita!'));
    await s.send({ phone: '351934555666', name: 'Rita Faria' }, 'Olá');

    const all = await s.api<CustomerList>('');
    expect(all.total).toBe(2);
    expect(all.items.map((c) => c.name).sort()).toEqual(['Carlos Mendes', 'Rita Faria']);
    expect((await s.api<CustomerList>('?q=912 000')).items.map((c) => c.id)).toEqual([customerId]);

    const bad = await s.api<{ message: string }>(
      `/${customerId}`,
      { method: 'PATCH', body: JSON.stringify({ nif: '12' }) },
      400,
    );
    expect(bad.message).toMatch(/NIF/);
    const edited = await s.api<CustomerDetail>(`/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Carlos Mendes',
        company: 'Mendes Carpintaria, Lda',
        nif: '509 999 999',
        role: 'carpenter',
        regions: ['Sintra', 'Cascais'],
      }),
    });
    expect(edited).toMatchObject({
      nif: '509999999',
      role: 'carpenter',
      regions: ['Sintra', 'Cascais'],
    });
    expect((await s.api<CustomerList>('?q=carpintaria')).items).toHaveLength(1);
    expect((await s.api<CustomerList>('?role=carpenter')).items.map((c) => c.id)).toEqual([
      customerId,
    ]);

    const noted = await s.api<CustomerDetail>(
      `/${customerId}/notes`,
      { method: 'POST', body: JSON.stringify({ body: 'Paga sempre a pronto.' }) },
      201,
    );
    expect(noted.notes).toEqual([
      expect.objectContaining({
        body: 'Paga sempre a pronto.',
        author: expect.objectContaining({ email: 'admin@example.invalid' }),
      }),
    ]);

    // The record's facts reach the agent's turn context.
    s.claude.script.push(say('Bom dia.'));
    await s.send(CARLOS, 'Bom dia');
    expect(turnContextOf(s.claude.bodies.at(-1)!)).toContain(
      'Customer record kept by the team: name Carlos Mendes; company Mendes Carpintaria, Lda; role Carpinteiro (carpenter); regions Sintra, Cascais.',
    );
    expect(turnContextOf(s.claude.bodies.at(-1)!)).not.toContain('509999999');
  });

  it('shows sales only the records with a lead on their branches', async () => {
    const s = await setup();
    const { contact, customerId } = await firstConversation(s);
    const porto = await s.t.member('acme', {
      email: 'porto@example.invalid',
      role: 'sales',
      branches: ['porto'],
    });
    expect((await s.api<CustomerList>('', {}, 200, porto.token)).items).toEqual([]);
    expect((await s.api<{ error: string }>(`/${customerId}`, {}, 403, porto.token)).error).toBe(
      'forbidden_branch',
    );
    await s.t.db.insert(leads).values([
      { clientId: 'acme', contactId: contact.id, type: 'quote', branchId: 'porto', fields: {} },
      { clientId: 'acme', contactId: contact.id, type: 'info', branchId: 'lisboa', fields: {} },
    ]);
    const list = await s.api<CustomerList>('', {}, 200, porto.token);
    expect(list.items.map((c) => [c.id, c.leads])).toEqual([[customerId, 1]]);
    await s.t.db.insert(quotes).values(
      ['porto', 'lisboa'].map((branchId, i) => ({
        clientId: 'acme',
        contactId: contact.id,
        branchId,
        number: `ACME-2026-000${i + 1}`,
        validUntil: '2026-11-30',
      })),
    );
    const detail = await s.api<CustomerDetail>(`/${customerId}`, {}, 200, porto.token);
    expect(detail.leads.map((l) => l.branchId)).toEqual(['porto']);
    expect(detail.quotes.map((q) => q.number)).toEqual(['ACME-2026-0001']);
  });

  it('keeps each client’s customers apart, even with the same number', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    s.claude.script.push(say('Olá!'));
    await s.send(CARLOS, 'Olá, outra empresa.', 'beta');
    const betaContact = await s.contactOf(CARLOS.phone, 'beta');
    expect(betaContact.customerId).not.toBe(customerId);
    // Beta's agent sees nothing from Acme's profile.
    expect(turnContextOf(s.claude.bodies.at(-1)!)).not.toMatch(/detail_level|Deck de pinho/);

    const betaAdmin = await s.t.member('beta', { email: 'b@example.invalid', role: 'admin' });
    const res = await s.t.call(`/api/admin/clients/beta/customers/${customerId}`, betaAdmin.token);
    expect(res.status).toBe(404);
    const other = await s.t.call(`/api/admin/clients/acme/customers`, betaAdmin.token);
    expect(other.status).toBe(403);
  });

  it('links a second number (merging its record), unlinks it, and the privacy tools cover both', async () => {
    const s = await setup();
    const { customerId } = await firstConversation(s);
    await s.api(`/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ company: 'Mendes Carpintaria, Lda', nif: '509999999' }),
    });
    // His work phone wrote too, and has its own record with a note.
    const WORK = { phone: '351965000222', name: 'Mendes Carpintaria' };
    s.claude.script.push(say('Olá!'));
    await s.send(WORK, 'Olá, é do escritório do Carlos.');
    const work = await s.contactOf(WORK.phone);
    await s.api(
      `/${work.customerId}/notes`,
      { method: 'POST', body: JSON.stringify({ body: 'Escritório.' }) },
      201,
    );

    const linked = await s.api<CustomerDetail>(`/${customerId}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ phone: '+351 965 000 222' }),
    });
    expect(linked.contacts.map((c) => c.phone)).toEqual([CARLOS.phone, WORK.phone]);
    expect(linked.notes.map((n) => n.body)).toEqual(['Escritório.']);
    expect(linked.conversations).toHaveLength(2);
    expect(await s.t.db.select().from(customers).where(eq(customers.id, work.customerId!))).toEqual(
      [],
    );
    expect((await s.api<CustomerList>('')).total).toBe(1);

    // A number that has not written yet becomes a contact of the record.
    const third = await s.api<CustomerDetail>(`/${customerId}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ phone: '351210000999' }),
    });
    expect(third.contacts).toHaveLength(3);
    const unlinked = await s.api<CustomerDetail>(
      `/${customerId}/contacts/${third.contacts[2]!.id}`,
      { method: 'DELETE' },
    );
    expect(unlinked.contacts).toHaveLength(2);

    // Export from either number covers the whole record.
    const res = await s.t.call(
      `/api/admin/clients/acme/privacy/customers/${work.id}/export`,
      s.admin.token,
    );
    const doc = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))['data.json']!),
    ) as {
      data: {
        contacts: unknown[];
        customer_records: { company: string; notes: unknown[] }[];
        customer_profile: unknown[];
      };
    };
    expect(doc.data.contacts).toHaveLength(2);
    expect(doc.data.customer_records).toEqual([
      expect.objectContaining({ company: 'Mendes Carpintaria, Lda', notes: [expect.anything()] }),
    ]);
    expect(doc.data.customer_profile).toHaveLength(3);

    // Delete from one number removes both numbers, the record, its notes and profile.
    const del = await s.t.call(
      `/api/admin/clients/acme/privacy/customers/${work.id}/delete`,
      s.admin.token,
      { method: 'POST', body: JSON.stringify({ confirm: CARLOS.phone }) },
    );
    expect(del.status, await del.clone().text()).toBe(200);
    expect(((await del.json()) as PrivacyActionResult).counts).toMatchObject({
      contacts: 2,
      customer_records: 1,
      customer_profile: 3,
    });
    expect(
      await s.t.db.select().from(customers).where(eq(customers.clientId, 'acme')),
    ).toHaveLength(1);
    expect(await s.t.db.select().from(customerNotes)).toEqual([]);
    expect(await s.t.db.select().from(customerProfileFields)).toEqual([]);
    expect((await s.api<CustomerList>('')).items.map((c) => c.phones)).toEqual([['351210000999']]);
  });
});
