import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AdminLeadDetail,
  ClientConfig,
  InboxConversationDetail,
  InboxList,
  MetaSendMessage,
  QuoteDetail,
  QuoteDraftInput,
  QuoteListItem,
} from '@wa/shared';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeResponder } from '../../agent/claude-responder.js';
import {
  agentRuns,
  contacts,
  conversations,
  leads,
  outbox,
  products,
  quotes,
} from '../../db/schema.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { DbLeadSink } from '../../leads/sink.js';
import { ResendTransport } from '../../mail/mailer.js';
import { agentTools } from '../../agent/registry.js';
import { adminTestApp } from '../../test/admin.js';
import { testClient } from '../../test/helpers.js';
import { quoteEmail } from './email.js';
import { PdfLibQuoteRenderer, totalRows } from './pdf.js';
import { quotePrefix } from './service.js';

const base = testClient().branches[0]!;
const acme = testClient({
  timezone: 'Europe/Lisbon',
  branches: [
    { ...base, id: 'lisboa', name: 'Lisboa (Loja)' },
    { ...base, id: 'porto', name: 'Porto', region: 'Norte' },
  ],
  tools: ['calculate_quantity', 'save_lead', 'send_order_draft'],
  quotes: {
    prefix: 'ACM',
    number_digits: 4,
    validity_days: 30,
    vat_percent: 23,
    company: {
      legal_name: 'Acme Madeiras, Lda.',
      nif: '500000000',
      address: 'Rua 1, 1000-001 Lisboa',
      phone: '+351 210 000 000',
      email: 'geral@acme.example',
    },
    conditions: ['Transporte não incluído.', 'Pagamento: 50 % na adjudicação.'],
    footer: 'Acme Madeiras, Lda. · Capital social 50 000 € · CRC Lisboa',
  } as ClientConfig['quotes'],
});
const beta = testClient({
  id: 'beta',
  name: 'Beta Lda',
  channel: { type: 'simulator', phone_number_id: 'beta-phone', display_phone_number: '+351 1' },
});

/** A deck sold by the m²: 59,90 €/m² with IVA, 1,2 m² per box. */
const DECK = {
  clientId: 'acme',
  productId: 'p-deck',
  variantId: 'deck-1',
  sku: 'DECK-CUM-21',
  title: 'Deck Cumaru 21x145',
  productType: 'Deck',
  price: '59.90',
  available: true,
  url: 'https://loja.example.pt/products/deck-cumaru',
  extra: { m2_per_box: 1.2, price_unit: 'm2' },
};
const OIL = {
  ...DECK,
  productId: 'p-oil',
  variantId: 'oil-1',
  sku: 'OIL-1L',
  title: 'Óleo para deck',
  productType: 'Manutenção',
  price: '25.00',
  extra: {},
};

type T = Awaited<ReturnType<typeof adminTestApp>>;
let current: T | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

async function setup(opts: { responder?: Responder; logo?: Uint8Array } = {}) {
  const t = await adminTestApp({
    clients: [acme, beta],
    responder: opts.responder,
    quotePdf: new PdfLibQuoteRenderer({
      fetch: (async () =>
        opts.logo
          ? new Response(opts.logo as Uint8Array<ArrayBuffer>)
          : new Response('no', { status: 404 })) as unknown as typeof fetch,
    }),
  });
  current = t;
  await t.db.insert(products).values([DECK, OIL]);
  const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
  const sales = await t.member('acme', {
    email: 'vendas@example.invalid',
    name: 'Rita Lopes',
    role: 'sales',
    branches: ['lisboa'],
  });
  const porto = await t.member('acme', {
    email: 'porto@example.invalid',
    role: 'sales',
    branches: ['porto'],
  });
  const json = async <R>(res: Response | Promise<Response>, status = 200): Promise<R> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as R;
  };
  const api = (path: string, token: string, init: RequestInit = {}) =>
    t.call(`/api/admin/clients/acme/quotes${path}`, token, init);
  /** A lead stored as the agent would, with a contact and an open conversation. */
  const lead = async (
    fields: Record<string, unknown>,
    o: { branchId?: string; type?: string } = {},
  ) => {
    const waId = `3519${Math.floor(Math.random() * 1e8)}`;
    const contact = await t.messages.upsertContact('acme', waId, 'Ana Costa');
    const conversation = await t.messages.openConversation('acme', contact.id);
    return new DbLeadSink(t.db).insert({
      id: randomUUID(),
      createdAt: new Date(),
      client: acme,
      conversationId: conversation.id,
      contact: { id: contact.id, name: contact.name, waId },
      type: o.type ?? 'quote',
      branchId: o.branchId ?? 'lisboa',
      fields,
    });
  };
  return { ...t, admin, sales, porto, json, api, lead };
}

const WIN_ANSI: Record<string, string> = { '\x80': '€', '\x95': '•', '\x96': '–', '\x97': '—' };

/** Every string drawn in a PDF, decoded (Helvetica text is drawn as hex WinAnsi strings). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents && 'asArray' in contents ? contents.asArray() : [contents];
    for (const ref of streams) {
      const stream = doc.context.lookup(ref as never) as { contents?: Uint8Array };
      if (!stream?.contents) continue;
      const raw = Buffer.from(stream.contents);
      let text: string;
      try {
        text = inflateSync(raw).toString('latin1');
      } catch {
        text = raw.toString('latin1');
      }
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
        const bytes = Buffer.from(m[1]!, 'hex').toString('latin1');
        out.push(bytes.replace(/[\x80\x95\x96\x97]/g, (c) => WIN_ANSI[c] ?? c));
      }
    }
  }
  return out.join('\n');
}

describe('quotes from a lead', () => {
  it('prefills from an order draft: catalogue items at today’s net price, pickup, NIF', async () => {
    const t = await setup();
    const row = await t.lead(
      {
        name: 'Ana Costa',
        phone: '+351911111111',
        email: 'ana@example.invalid',
        nif: '123456789',
        fulfilment: 'pickup',
        pickup_branch: 'lisboa',
        items: [
          { variant_id: 'oil-1', title: 'Óleo para deck', quantity: 3, unit_price_eur: 20 },
          {
            variant_id: 'gone',
            title: 'Viga antiga',
            variant: '3 m',
            quantity: 2,
            unit_price_eur: 12.3,
          },
        ],
        other_items: [{ description: 'Ripado de showroom', quantity: '40 m²' }],
      },
      { type: 'order' },
    );
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    expect(q.number).toMatch(/^ACM-\d{4}-0001$/);
    expect(q.status).toBe('draft');
    expect(q.customer).toEqual({
      name: 'Ana Costa',
      company: null,
      nif: '123456789',
      email: 'ana@example.invalid',
      phone: '+351911111111',
      address: null,
    });
    expect(q.fulfilment).toBe('Levantamento em Lisboa (Loja)');
    expect(q.lines).toEqual([
      expect.objectContaining({
        variantId: 'oil-1',
        sku: 'OIL-1L',
        quantity: 3,
        unitPrice: 20.3252,
      }),
      expect.objectContaining({ description: 'Viga antiga – 3 m', quantity: 2, unitPrice: 10 }),
      expect.objectContaining({
        description: 'Ripado de showroom (40 m²)',
        quantity: 1,
        unitPrice: 0,
      }),
    ]);
    // 3 × 25,00 + 2 × 12,30 with IVA on the store; net lines are rounded to the cent and IVA is
    // added on the subtotal (60,98 + 20,00 + 23 %), so the quote can differ by a cent.
    expect(q.totals).toMatchObject({ netCents: 8098, vatCents: 1863, totalCents: 9961 });
    expect(q.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Numbers go up per client and year; another client starts at 1.
    const second = await t.json<QuoteDetail>(
      t.api('', t.admin.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    expect(second.number).toMatch(/^ACM-\d{4}-0002$/);
    const list = await t.json<QuoteListItem[]>(t.api(`?lead=${row.id}`, t.sales.token));
    expect(list.map((l) => l.number)).toEqual([second.number, q.number]);
  });

  it('falls back to the products the agent noted, to price by hand', async () => {
    const t = await setup();
    const row = await t.lead({
      name: 'Rui',
      products: 'Deck em cumaru',
      area_m2: 45,
      location: 'Sintra',
    });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    expect(q.lines).toEqual([
      expect.objectContaining({
        description: 'Deck em cumaru',
        quantity: 45,
        unit: 'm²',
        unitPrice: 0,
      }),
    ]);
    expect(q.customer.address).toBe('Sintra');
  });

  it('computes totals on the server from the lines, never from what the browser sends', async () => {
    const t = await setup();
    const row = await t.lead({ name: 'Rui', products: 'Deck' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    const draft: QuoteDraftInput & { totals?: unknown } = {
      customer: { ...q.customer, email: 'rui@example.invalid' },
      lines: [
        {
          description: 'Deck Cumaru',
          quantity: 27,
          unit: 'cx',
          unitPrice: 58.439,
          discountPercent: 10,
          vatPercent: 23,
        },
        { description: 'Transporte', quantity: 1, unitPrice: 80, vatPercent: 23 },
      ],
      discount: { kind: 'amount', value: 50 },
      validUntil: '2026-12-31',
      notes: 'Inclui montagem.',
      totals: { totalCents: 1 },
    };
    const saved = await t.json<QuoteDetail>(
      t.api(`/${q.id}`, t.sales.token, { method: 'PUT', body: JSON.stringify(draft) }),
    );
    // 27 × 58,439 = 1577,85; −10 % = 157,79 (157,785) → 1420,06; + 80 = 1500,06; −50 = 1450,06
    expect(saved.totals).toMatchObject({
      subtotalCents: 150006,
      discountCents: 5000,
      netCents: 145006,
      vatCents: 33351, // 23 % of 1450,06 = 333,5138
      totalCents: 178357,
    });
    const [stored] = await t.db.select().from(quotes).where(eq(quotes.id, q.id));
    expect(stored!.totalCents).toBe(178357);
    expect(saved.lines[1]).toMatchObject({ unit: 'un', discountPercent: 0, sku: null });

    const bad = await t.api(`/${q.id}`, t.sales.token, {
      method: 'PUT',
      body: JSON.stringify({ ...draft, lines: [{ ...draft.lines[0], quantity: -1 }] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/maior que zero/);
  });

  it('scopes quotes to the member’s branches and the client', async () => {
    const t = await setup();
    const row = await t.lead({ name: 'Ana', products: 'Deck' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    expect((await t.api(`/${q.id}`, t.porto.token)).status).toBe(403);
    expect(
      (await t.api('', t.porto.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }))
        .status,
    ).toBe(403);
    const other = await t.member('beta', { email: 'b@example.invalid', role: 'admin' });
    const res = await t.call(`/api/admin/clients/beta/quotes/${q.id}`, other.token);
    expect(res.status).toBe(404);
    expect((await t.api(`/${q.id}`, t.admin.token)).status).toBe(200);
  });

  it('emails the PDF to the customer, from the dashboard', async () => {
    const t = await setup();
    const row = await t.lead({ name: 'Ana Costa', email: 'ana@example.invalid', products: 'Deck' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    await t.api(`/${q.id}`, t.sales.token, {
      method: 'PUT',
      body: JSON.stringify({ ...q, lines: [{ ...q.lines[0], unitPrice: 40 }] }),
    });
    const sent = await t.json<QuoteDetail>(
      t.api(`/${q.id}/send`, t.sales.token, {
        method: 'POST',
        body: JSON.stringify({ channel: 'email' }),
      }),
    );
    expect(sent.status).toBe('sent');
    expect(sent.sends).toEqual([
      expect.objectContaining({
        channel: 'email',
        to: 'ana@example.invalid',
        by: expect.objectContaining({ name: 'Rita Lopes' }),
      }),
    ]);
    const [email] = await t.db.select().from(outbox).where(eq(outbox.kind, 'quote'));
    expect(email).toMatchObject({
      to: ['ana@example.invalid'],
      subject: `Orçamento ${q.number} – Acme Madeiras, Lda.`,
    });
    expect(email!.body).toContain('Olá Ana,');
    expect(email!.body).toContain('Rita Lopes');

    const lead = await t.json<AdminLeadDetail>(
      t.call(`/api/admin/clients/acme/leads/${row.id}`, t.sales.token),
    );
    expect(lead.status).toBe('quoted');
    expect(lead.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['quote_sent', 'status']),
    );

    // Locked once sent.
    const edit = await t.api(`/${q.id}`, t.sales.token, { method: 'PUT', body: JSON.stringify(q) });
    expect(edit.status).toBe(409);
    expect((await t.api(`/${q.id}`, t.sales.token, { method: 'DELETE' })).status).toBe(409);
  });

  it('asks for an email when the quote has none, and refuses empty quotes', async () => {
    const t = await setup();
    const row = await t.lead({ name: 'Ana' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    const send = (body: unknown) =>
      t.api(`/${q.id}/send`, t.sales.token, { method: 'POST', body: JSON.stringify(body) });
    expect((await send({ channel: 'email' })).status).toBe(400); // no lines
    await t.api(`/${q.id}`, t.sales.token, {
      method: 'PUT',
      body: JSON.stringify({
        ...q,
        lines: [{ description: 'Deck', quantity: 1, unitPrice: 1, vatPercent: 23 }],
      }),
    });
    const res = await send({ channel: 'email' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('no_email');
    expect((await t.db.select().from(quotes).where(eq(quotes.id, q.id)))[0]!.status).toBe('draft');
    // Deleting a draft is allowed.
    expect((await t.api(`/${q.id}`, t.sales.token, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('the quote PDF', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  it('has the letterhead, customer, lines, totals, conditions and footer', async () => {
    const t = await setup({ logo: PNG });
    const row = await t.lead({ name: 'Ana Costa', products: 'Deck' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    await t.api(`/${q.id}`, t.sales.token, {
      method: 'PUT',
      body: JSON.stringify({
        ...q,
        customer: { ...q.customer, nif: '123456789', address: 'Rua das Flores 3, Sintra' },
        lines: [
          {
            sku: 'DECK-CUM-21',
            description: 'Deck Cumaru 21x145 (32,4 m²)',
            quantity: 27,
            unit: 'cx',
            unitPrice: 58.439,
            vatPercent: 23,
          },
          {
            description: 'Montagem — equipa própria ✓',
            quantity: 32.4,
            unit: 'm²',
            unitPrice: 12.5,
            discountPercent: 5,
            vatPercent: 23,
          },
        ],
        fulfilment: 'Entrega em Sintra',
        notes: 'Prazo de entrega: 2 semanas.',
      }),
    });
    const res = await t.api(`/${q.id}/pdf`, t.sales.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const text = await pdfText(bytes);
    for (const s of [
      'Orçamento',
      q.number,
      'RASCUNHO',
      'Acme Madeiras, Lda.',
      'NIF 500000000',
      'Ana Costa',
      'NIF 123456789',
      'Entrega em Sintra',
      'DECK-CUM-21',
      '1 577,85 €',
      '384,75 €', // 32,4 × 12,5 = 405,00 − 5 % = 384,75
      'Subtotal',
      '1 962,60 €',
      'IVA 23 % sobre 1 962,60 €',
      '451,40 €', // 451,398
      '2 414,00 €',
      'Prazo de entrega: 2 semanas.',
      'Transporte não incluído.',
      'Capital social 50 000 €',
      'Página 1 de 1',
    ]) {
      expect(text).toContain(s);
    }
    // Characters Helvetica cannot draw are replaced, not fatal.
    expect(text).toContain('Montagem — equipa própria ?');
  });

  it('runs onto more pages with the table header repeated', async () => {
    const renderer = new PdfLibQuoteRenderer();
    const lines = Array.from({ length: 60 }, (_, i) => ({
      variantId: null,
      sku: `REF-${i}`,
      description: `Linha ${i} com uma descrição comprida que ocupa duas linhas na tabela do orçamento`,
      quantity: 1,
      unit: 'un',
      unitPrice: 1,
      discountPercent: 0,
      vatPercent: 23,
    }));
    const { computeQuoteTotals } = await import('@wa/shared');
    const bytes = await renderer.render({
      client: acme,
      number: 'ACM-2026-0007',
      issuedAt: new Date('2026-10-23T10:00:00Z'),
      validUntil: '2026-11-22',
      customer: { name: 'X', company: null, nif: null, email: null, phone: null, address: null },
      lines,
      discount: null,
      totals: computeQuoteTotals(lines),
      fulfilment: null,
      notes: null,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const text = await pdfText(bytes);
    expect(text).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
    expect(text).toContain('ACM-2026-0007 (continuação)');
    expect(text).toContain('23/10/2026');
    expect(text).toContain('Orçamento válido até 22/11/2026.');
    expect(text).not.toContain('RASCUNHO');
  });

  it('lists the global discount and each IVA rate', () => {
    expect(
      totalRows(
        {
          lines: [],
          subtotalCents: 10000,
          discountCents: 1000,
          netCents: 9000,
          vat: [
            { percent: 23, baseCents: 6000, vatCents: 1380 },
            { percent: 6, baseCents: 3000, vatCents: 180 },
          ],
          vatCents: 1560,
          totalCents: 10560,
        },
        { kind: 'percent', value: 10 },
      ),
    ).toEqual([
      { label: 'Subtotal', value: '100,00 €' },
      { label: 'Desconto (10 %)', value: '-10,00 €' },
      { label: 'Total sem IVA', value: '90,00 €' },
      { label: 'IVA 23 % sobre 60,00 €', value: '13,80 €' },
      { label: 'IVA 6 % sobre 30,00 €', value: '1,80 €' },
      { label: 'Total', value: '105,60 €', strong: true },
    ]);
  });
});

describe('the quote email', () => {
  it('attaches the PDF when delivered through Resend', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new ResendTransport('re_test', (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: 'x' });
    }) as unknown as typeof fetch);
    const email = quoteEmail({
      client: acme,
      phone: '351911111111',
      to: 'ana@example.invalid',
      replyTo: 'rita@example.invalid',
      customerName: 'Ana Costa',
      number: 'ACM-2026-0001',
      totalCents: 194076,
      validUntil: '2026-11-22',
      sender: 'Rita Lopes',
      filename: 'Orcamento-ACM-2026-0001.pdf',
      pdf: new Uint8Array([37, 80, 68, 70]),
    });
    expect(email.text).toContain('no valor de 1 940,76 € (IVA incluído), válido até 22/11/2026');
    await transport.deliver(email, 'k');
    expect(bodies[0]).toMatchObject({
      to: ['ana@example.invalid'],
      reply_to: 'rita@example.invalid',
      attachments: [{ filename: 'Orcamento-ACM-2026-0001.pdf', content: 'JVBERg==' }],
    });
  });

  it('uses the client id as the default prefix', () => {
    expect(quotePrefix(testClient({ id: 'jular-2' }))).toBe('JULAR2');
  });
});

describe('a demo deck lead, end to end', () => {
  it('goes from the agent’s calculation to a PDF in the simulator chat, and the lead is quoted', async () => {
    // The agent works out the boxes for 30 m² of deck, then saves the quote request.
    const replies = [
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'calculate_quantity',
            input: { variant_id: 'deck-1', area_m2: 30 },
          },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'save_lead',
            input: {
              request_type: 'quote',
              name: 'Ana Costa',
              email: 'ana@example.invalid',
              location: 'Cascais, Lisboa',
              products: 'Deck Cumaru 21x145, 30 m²',
              area_m2: 30,
              summary: 'Quer orçamento de 30 m² de deck em cumaru, com entrega.',
            },
          },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'São 27 caixas. Pedido registado!' }],
        stop_reason: 'end_turn',
      },
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
    const agent: { responder?: ClaudeResponder } = {};
    const t = await setup({
      responder: {
        respond: (input) => agent.responder!.respond(input),
        invalidate: (id) => agent.responder!.invalidate(id),
      },
    });
    agent.responder = new ClaudeResponder({
      db: t.db,
      anthropic,
      tools: agentTools,
      backoffice: t.backoffice,
    });
    const phone = '351912345678';
    await t.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, name: 'Ana', text: 'Quanto fica um deck de 30 m² em cumaru?' }),
    });
    await t.queue.drain();
    const [lead] = await t.db.select().from(leads);
    expect(lead).toMatchObject({ type: 'quote', status: 'new' });
    expect((await t.db.select().from(agentRuns))[0]!.toolCalls).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'calculate_quantity', ok: true })]),
    );

    // Click 1: Create quote. The calculator's boxes, at the box price, are already there.
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: lead!.id }) }),
      201,
    );
    expect(q.lines).toEqual([
      {
        variantId: 'deck-1',
        sku: 'DECK-CUM-21',
        description: 'Deck Cumaru 21x145 (32,4 m²)',
        quantity: 27, // 30 m² + 7 % = 32,1 m² → 27 boxes of 1,2 m²
        unit: 'cx',
        unitPrice: 58.439, // 71,88 € per box with IVA
        discountPercent: 0,
        vatPercent: 23,
      },
    ]);
    expect(q.customer).toMatchObject({
      name: 'Ana Costa',
      email: 'ana@example.invalid',
      phone: `+${phone}`,
    });
    // The calculator's total: 27 × 71,88 € = 1940,76 €.
    expect(q.totals).toMatchObject({ netCents: 157785, vatCents: 36291, totalCents: 194076 });
    expect(q.canSendWhatsapp).toBe(true);

    // Click 2: Send by WhatsApp.
    const events: unknown[] = [];
    const stop = t.bus.subscribe(`acme:${phone}`, (e) => events.push(e));
    const sent = await t.json<QuoteDetail>(
      t.api(`/${q.id}/send`, t.sales.token, {
        method: 'POST',
        body: JSON.stringify({ channel: 'whatsapp' }),
      }),
    );
    stop();
    expect(sent).toMatchObject({
      status: 'sent',
      sends: [expect.objectContaining({ channel: 'whatsapp', to: `+${phone}` })],
    });

    // The simulator chat shows the document.
    const { messages } = await t.messages.history('acme', phone);
    const doc = messages.at(-1)!;
    expect(doc).toMatchObject({ direction: 'outbound', type: 'document' });
    const payload = doc.payload as Extract<MetaSendMessage, { type: 'document' }>;
    expect(payload.document.filename).toBe(`Orcamento-${q.number}.pdf`);
    expect(payload.document.caption).toBe(
      `Orçamento ${q.number} da Acme Madeiras, Lda.: 1 940,76 € com IVA, válido até ${q.validUntil.split('-').reverse().join('/')}.`,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'message' }));
    // The inbox shows it as a document sent by the member, with its file name in the list.
    await t.inbox.flush();
    const inbox = await t.json<InboxList>(t.call('/api/admin/clients/acme/inbox', t.admin.token));
    const row = inbox.conversations.find((c) => c.contact.phone === phone)!;
    expect(row.lastMessage).toMatchObject({
      direction: 'outbound',
      text: `Documento: Orcamento-${q.number}.pdf`,
      byMember: true,
    });
    const detail = await t.json<InboxConversationDetail>(
      t.call(`/api/admin/clients/acme/inbox/${row.id}`, t.admin.token),
    );
    expect(detail.messages.at(-1)).toMatchObject({
      type: 'document',
      sentBy: expect.objectContaining({ name: 'Rita Lopes' }),
    });
    // WhatsApp (or the simulator) downloads the PDF from the public link.
    const link = new URL(payload.document.link);
    expect(link.origin).toBe('http://test.local');
    const file = await t.app.request(link.pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    const text = await pdfText(new Uint8Array(await file.arrayBuffer()));
    expect(text).toContain('1 940,76 €');
    expect(text).not.toContain('RASCUNHO');
    expect(
      (await t.app.request(link.pathname.replace(/quotes\/[^/]+/, 'quotes/wrongtokenwrongtoken')))
        .status,
    ).toBe(404);

    // The lead is quoted, and the history says by whom.
    const after = await t.json<AdminLeadDetail>(
      t.call(`/api/admin/clients/acme/leads/${lead!.id}`, t.sales.token),
    );
    expect(after.status).toBe('quoted');
    expect(after.quotedAt).not.toBeNull();
    expect(after.events.find((e) => e.kind === 'quote_sent')).toMatchObject({
      kind: 'quote_sent',
      actor: expect.objectContaining({ name: 'Rita Lopes' }),
      data: { quoteId: q.id, number: q.number, channel: 'whatsapp', totalCents: 194076 },
    });

    // The link expires 14 days after the send; sending by WhatsApp again issues a new one.
    const [locked] = await t.db.select().from(quotes).where(eq(quotes.id, q.id));
    const days = (locked!.publicTokenExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    await t.db
      .update(quotes)
      .set({ publicTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(quotes.id, q.id));
    expect((await t.app.request(link.pathname)).status).toBe(404);
    await t.json<QuoteDetail>(
      t.api(`/${q.id}/send`, t.sales.token, {
        method: 'POST',
        body: JSON.stringify({ channel: 'whatsapp' }),
      }),
    );
    const again = (await t.messages.history('acme', phone)).messages.at(-1)!;
    const newLink = new URL(
      (again.payload as Extract<MetaSendMessage, { type: 'document' }>).document.link,
    );
    expect(newLink.pathname).not.toBe(link.pathname);
    expect((await t.app.request(newLink.pathname)).status).toBe(200);
    expect((await t.app.request(link.pathname)).status).toBe(404);

    // Sending again delivers the same PDF; a won lead is not moved back.
    await t.db.update(leads).set({ status: 'won' }).where(eq(leads.id, lead!.id));
    await t.json<QuoteDetail>(
      t.api(`/${q.id}/send`, t.sales.token, {
        method: 'POST',
        body: JSON.stringify({ channel: 'email', email: 'outra@example.invalid' }),
      }),
    );
    expect((await t.db.select().from(leads))[0]!.status).toBe('won');
  });
});

describe('quotes and the privacy tools', () => {
  it('exports the quotes with their PDFs and anonymises them on delete', async () => {
    const t = await setup();
    const row = await t.lead({ name: 'Ana Costa', email: 'ana@example.invalid', products: 'Deck' });
    const q = await t.json<QuoteDetail>(
      t.api('', t.sales.token, { method: 'POST', body: JSON.stringify({ leadId: row.id }) }),
      201,
    );
    await t.api(`/${q.id}`, t.sales.token, {
      method: 'PUT',
      body: JSON.stringify({
        ...q,
        lines: [{ ...q.lines[0], unitPrice: 10 }],
        notes: 'Ligar à Ana',
      }),
    });
    const sent = await t.json<QuoteDetail>(
      t.api(`/${q.id}/send`, t.sales.token, {
        method: 'POST',
        body: JSON.stringify({ channel: 'whatsapp' }),
      }),
    );
    const [message] = (await t.messages.history('acme', sent.sends[0]!.to.slice(1))).messages.slice(
      -1,
    );
    const link = new URL((message!.payload as { document: { link: string } }).document.link);

    const collected = await t.privacy.collect(acme, row.contactId!);
    expect(collected.document.data['quotes']).toEqual([
      expect.objectContaining({
        number: q.number,
        notes: 'Ligar à Ana',
        totalCents: q.totals.totalCents || expect.any(Number),
      }),
    ]);
    expect(collected.files.map((f) => f.path)).toEqual([
      `media/quotes/quotes/Orcamento-${q.number}.pdf`,
    ]);

    const adminRow = (await t.team.list('acme')).find((m) => m.role === 'admin')!;
    const { counts } = await t.privacy.deleteCustomer(acme, row.contactId!, { actor: adminRow });
    expect(counts['quotes_anonymised']).toBe(1);
    const [after] = await t.db.select().from(quotes).where(eq(quotes.id, q.id));
    expect(after).toMatchObject({
      contactId: null,
      conversationId: null,
      notes: null,
      publicToken: null,
      number: q.number,
    });
    expect((after!.customer as { name: string | null }).name).toBeNull();
    expect((after!.sends as { to: string }[])[0]!.to).toBe('');
    expect((await t.app.request(link.pathname)).status).toBe(404);
    expect(await t.db.select().from(contacts).where(eq(contacts.id, row.contactId!))).toEqual([]);
    expect(
      await t.db.select().from(conversations).where(eq(conversations.contactId, row.contactId!)),
    ).toEqual([]);
  });
});
