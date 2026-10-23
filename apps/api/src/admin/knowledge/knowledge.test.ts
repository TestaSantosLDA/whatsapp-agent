import Anthropic from '@anthropic-ai/sdk';
import type {
  KnowledgeDocumentDetail,
  KnowledgeDocumentView,
  KnowledgeProposalView,
} from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateQuantityTool } from '../../agent/tools/calculate-quantity.js';
import { documentTitle, searchDocumentsTool } from '../../agent/tools/search-documents.js';
import { syncCatalogue } from '../../catalogue/sync.js';
import { documents, productDataOverrides, products } from '../../db/schema.js';
import { MemoryFileStore, storageKey } from '../../knowledge/file-store.js';
import { searchPassages } from '../../knowledge/search.js';
import { seedDocument } from '../../knowledge/seed.js';
import { adminTestApp } from '../../test/admin.js';
import { fixtureSource, shopClient, toolContext } from '../../test/catalogue.js';

type Extraction = { pages: { page: number; text: string }[]; proposals: unknown[] };

/** Anthropic answering `messages.parse` with a structured extraction, recording each request. */
function fakeReader(answer: (body: Record<string, unknown>) => Extraction) {
  const requests: Record<string, unknown>[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return Response.json({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_sequence: null,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 300 },
        content: [{ type: 'text', text: JSON.stringify(answer(body)) }],
      });
    },
  });
  return { anthropic, requests };
}

const proposal = (p: Partial<Record<string, unknown>> = {}) => ({
  page: 1,
  product: 'VIN-SPC-CN',
  product_name: 'Vinílico SPC Carvalho Natural',
  field: 'm2_per_box',
  value: '2,5',
  confidence: 0.92,
  quote: 'Caixa: 2,5 m²',
  ...p,
});

const CSV = [
  'Referência;Produto;m2 por caixa;Peso caixa (kg)',
  'VIN-SPC-CN;Vinílico SPC Carvalho Natural;2,5;21,3',
  'XYZ-999;Produto desconhecido;1,1;9',
].join('\n');

/** The smallest file that passes the PDF check; the fake reader never parses it. */
const TINY_PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(opts: { reader?: Anthropic | null } = {}) {
  const fake = fakeReader(() => ({
    pages: [],
    proposals: [
      proposal(),
      proposal({ field: 'weight_kg', value: '21,3', quote: 'Peso caixa 21,3 kg' }),
      proposal({ product: '', product_name: 'Produto desconhecido', value: '1,1' }),
    ],
  }));
  const client = shopClient();
  const other = shopClient({
    id: 'other',
    name: 'Outra Loja',
    channel: { ...client.channel, phone_number_id: 'other-phone-id' },
  });
  const files = new MemoryFileStore();
  const t = await adminTestApp({
    clients: [client, other],
    files,
    documentReader: opts.reader === null ? undefined : (opts.reader ?? fake.anthropic),
  });
  close = t.close;
  for (const c of [client, other]) {
    const synced = await syncCatalogue({ db: t.db, client: c, source: fixtureSource() });
    if (!synced.ok) throw new Error(synced.error);
  }
  const admin = await t.member('acme', { email: 'admin@acme.pt', role: 'admin' });
  const sales = await t.member('acme', {
    email: 'vendas@acme.pt',
    role: 'sales',
    branches: ['lisboa'],
  });
  const otherAdmin = await t.member('other', { email: 'admin@outra.pt', role: 'admin' });
  const base = '/api/admin/clients/acme/knowledge';

  const upload = (
    name: string,
    body: Uint8Array | string,
    token = admin.token,
    method = 'POST',
    path = '/documents',
  ) => {
    const form = new FormData();
    form.set('file', new File([body], name));
    return t.app.request(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  };
  const get = async <T>(path: string, token = admin.token) => {
    const r = await t.call(`${base}${path}`, token);
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = (path: string, body: unknown, token = admin.token) =>
    t.call(`${base}${path}`, token, { method: 'POST', body: JSON.stringify(body) });

  return { t, client, other, files, fake, admin, sales, otherAdmin, base, upload, get, post };
}

async function extraOf(db: Parameters<typeof toolContext>[0], sku: string, clientId = 'acme') {
  const [row] = await db
    .select({ extra: products.extra })
    .from(products)
    .where(and(eq(products.clientId, clientId), eq(products.sku, sku)));
  return row?.extra as Record<string, unknown>;
}

describe('knowledge uploads', () => {
  it('accepts the listed types only, within the size limit, from admins', async () => {
    const s = await setup();
    const exe = await s.upload('setup.exe', 'MZ');
    expect(exe.status).toBe(415);
    expect(((await exe.json()) as { message: string }).message).toMatch(/Tipo de ficheiro/);
    expect((await s.upload('vazio.csv', '')).status).toBe(400);
    // A renamed file: the name says PDF, the bytes do not.
    const fake = await s.upload('ficha.pdf', 'not a pdf');
    expect(fake.status).toBe(415);
    expect(((await fake.json()) as { message: string }).message).toMatch(/PDF válido/);
    const big = await s.upload('grande.csv', new Uint8Array(21 * 1024 * 1024).fill(65));
    expect(big.status).toBe(413);
    expect((await s.upload('tabela.csv', CSV, s.sales.token)).status).toBe(403);
    // Not sent as multipart.
    expect((await s.post('/documents', { file: 'x' })).status).toBe(400);
    expect(s.files.files.size).toBe(0);

    // Sales can read the list.
    const list = await s.get<KnowledgeDocumentView[]>('/documents', s.sales.token);
    expect(list).toEqual({ status: 200, body: [] });
  });

  it('stores the file under <clientId>/<docId>/<filename>', () => {
    expect(storageKey('acme', 'd1', 'Ficha técnica (v2).pdf')).toBe(
      'acme/d1/Ficha-tecnica-v2-.pdf',
    );
    expect(storageKey('acme', 'd1', '../../etc/passwd')).toBe('acme/d1/etc-passwd');
  });
});

describe('the processing pipeline', () => {
  it('reads a CSV locally, asks Claude for proposals and matches them to the catalogue', async () => {
    const s = await setup();
    const res = await s.upload('Tabela de preços.csv', CSV);
    expect(res.status).toBe(201);
    const created = (await res.json()) as KnowledgeDocumentView;
    expect(created).toMatchObject({
      status: 'processing',
      type: 'csv',
      name: 'Tabela de preços.csv',
    });
    expect([...s.files.files.keys()]).toEqual([`acme/${created.id}/Tabela-de-precos.csv`]);
    await s.t.queue.drain();

    // Claude got the passages as text, with the catalogue in the system prompt.
    expect(s.fake.requests).toHaveLength(1);
    const request = s.fake.requests[0]!;
    expect(request.model).toBe('claude-opus-5-5');
    expect(JSON.stringify(request.messages)).toContain(
      'Referência: VIN-SPC-CN · Produto: Vinílico SPC',
    );
    expect(JSON.stringify(request.system)).toContain('VIN-SPC-CN');
    expect((request.output_config as { format: { type: string } }).format.type).toBe('json_schema');

    const { body } = await s.get<KnowledgeDocumentDetail>(`/documents/${created.id}`);
    expect(body.document).toMatchObject({
      status: 'needs_review',
      passages: 1,
      proposals: { pending: 3, approved: 0, rejected: 0 },
      model: 'claude-opus-5-5',
    });
    expect(body.document.costUsd).toBeGreaterThan(0);
    expect(body.passages[0]).toMatchObject({ page: 1, label: 'Linhas 2–3' });
    const m2 = body.proposals.find((p) => p.field === 'm2_per_box' && p.productKey);
    expect(m2).toMatchObject({
      productKey: 'VIN-SPC-CN',
      productLabel: 'Pavimento Vinílico SPC Carvalho Natural',
      value: 2.5,
      status: 'pending',
      confidence: 0.92,
      quote: 'Caixa: 2,5 m²',
    });
    expect(body.proposals.find((p) => p.field === 'weight_kg')?.value).toBe(21.3);
    expect(body.proposals.find((p) => !p.productKey)?.productLabel).toBe('Produto desconhecido');
  });

  it('sends a PDF to Claude as a document block and keeps its pages for search', async () => {
    const fake = fakeReader(() => ({
      pages: [
        { page: 1, text: 'Ficha técnica Soalho Carvalho 14 mm. Caixa 1,6 m².' },
        { page: 2, text: 'Instalação flutuante sobre base de 2 mm.' },
      ],
      proposals: [
        proposal({
          page: 1,
          product: 'SOA-CAR-14',
          product_name: 'Soalho Carvalho 14 mm',
          value: '1,6',
        }),
      ],
    }));
    const s = await setup({ reader: fake.anthropic });
    const res = await s.upload('Ficha soalho.pdf', TINY_PDF);
    const doc = (await res.json()) as KnowledgeDocumentView;
    await s.t.queue.drain();

    const content = (
      fake.requests[0]!.messages as { content: { type: string; source?: { data: string } }[] }[]
    )[0]!.content;
    expect(content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
      title: 'Ficha soalho.pdf',
    });
    expect(Buffer.from(content[0]!.source!.data, 'base64').toString()).toMatch(/^%PDF/);

    const { body } = await s.get<KnowledgeDocumentDetail>(`/documents/${doc.id}`);
    expect(body.document.status).toBe('needs_review');
    expect(body.passages.map((p) => p.label)).toEqual(['Página 1', 'Página 2']);
    expect(body.proposals[0]).toMatchObject({ productKey: 'SOA-CAR-14', value: 1.6, page: 1 });
  });

  it('without Claude, makes spreadsheets searchable and fails PDFs with a message', async () => {
    const s = await setup({ reader: null });
    const csv = (await (await s.upload('tabela.csv', CSV)).json()) as KnowledgeDocumentView;
    const pdf = (await (await s.upload('ficha.pdf', TINY_PDF)).json()) as KnowledgeDocumentView;
    await s.t.queue.drain();
    const list = (await s.get<KnowledgeDocumentView[]>('/documents')).body;
    expect(list.find((d) => d.id === csv.id)).toMatchObject({ status: 'live', passages: 1 });
    expect(list.find((d) => d.id === pdf.id)).toMatchObject({ status: 'failed' });
    expect(list.find((d) => d.id === pdf.id)?.error).toMatch(/precisa do Claude/);
  });
});

describe('reviewing proposals', () => {
  async function reviewed() {
    const s = await setup();
    const doc = (await (await s.upload('tabela.csv', CSV)).json()) as KnowledgeDocumentView;
    await s.t.queue.drain();
    const detail = (await s.get<KnowledgeDocumentDetail>(`/documents/${doc.id}`)).body;
    const m2 = detail.proposals.find((p) => p.field === 'm2_per_box' && p.productKey)!;
    return { ...s, doc, detail, m2 };
  }

  it('an approved m² per box reaches the catalogue and the calculator at once', async () => {
    const s = await reviewed();
    // The fixture YAML for this client has no m² per box for the vinyl.
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toEqual({});
    expect(m2Current(s.m2)).toBeNull();

    expect(
      (await s.post(`/proposals/${s.m2.id}`, { action: 'approve' }, s.sales.token)).status,
    ).toBe(403);
    const res = await s.post(`/proposals/${s.m2.id}`, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'approved', finalValue: 2.5, current: 2.5 });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toMatchObject({ m2_per_box: 2.5 });

    // The next conversation's calculator uses it: 20 m² + 7% = 21,4 m² → 9 boxes of 2,5 m².
    const [vinyl] = await s.t.db.select().from(products).where(eq(products.sku, 'VIN-SPC-CN'));
    const ctx = toolContext(s.t.db, s.client);
    const result = await calculateQuantityTool.run(
      calculateQuantityTool.inputSchema.parse({ variant_id: vinyl!.variantId, rooms: '4 x 5' }),
      ctx,
    );
    expect(result).toMatchObject({ m2_per_box: 2.5, boxes: 9 });

    // A later catalogue sync keeps it (database over YAML).
    await syncCatalogue({ db: s.t.db, client: s.client, source: fixtureSource() });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toMatchObject({ m2_per_box: 2.5 });
  });

  it('approved data wins over the client YAML', async () => {
    const s = await reviewed();
    const yamlClient = shopClient({
      product_data: { 'VIN-SPC-CN': { m2_per_box: 2.2, price_unit: 'box' } },
    });
    await syncCatalogue({ db: s.t.db, client: yamlClient, source: fixtureSource() });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toMatchObject({ m2_per_box: 2.2 });
    await s.t.db.insert(productDataOverrides).values({
      clientId: 'acme',
      productKey: 'VIN-SPC-CN',
      field: 'm2_per_box',
      value: 2.5,
    });
    await syncCatalogue({ db: s.t.db, client: yamlClient, source: fixtureSource() });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toEqual({ m2_per_box: 2.5, price_unit: 'box' });
  });

  it('edits, rejects and bulk-approves', async () => {
    const s = await reviewed();
    const bad = await s.post(`/proposals/${s.m2.id}`, { action: 'approve', value: 'muito' });
    expect(bad.status).toBe(400);
    const edited = await s.post(`/proposals/${s.m2.id}`, { action: 'approve', value: '2,4' });
    expect(await edited.json()).toMatchObject({ status: 'edited', value: 2.5, finalValue: 2.4 });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toMatchObject({ m2_per_box: 2.4 });

    // Rejecting an approved value takes it back out of the catalogue.
    const rejected = await s.post(`/proposals/${s.m2.id}`, { action: 'reject' });
    expect(await rejected.json()).toMatchObject({ status: 'rejected' });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toEqual({});

    // The unmatched one needs a product: bulk approve skips it, a direct approve asks for one.
    const unmatched = s.detail.proposals.find((p) => !p.productKey)!;
    expect((await s.post(`/proposals/${unmatched.id}`, { action: 'approve' })).status).toBe(400);
    const bulk = await s.post(`/documents/${s.doc.id}/proposals`, { action: 'approve' });
    expect(await bulk.json()).toEqual({ decided: 1, skipped: 1 });
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toMatchObject({ weight_kg: 21.3 });
    const assigned = await s.post(`/proposals/${unmatched.id}`, {
      action: 'approve',
      productKey: 'SOA-CAR-14',
    });
    expect(await assigned.json()).toMatchObject({ status: 'edited', productKey: 'SOA-CAR-14' });

    const { body } = await s.get<KnowledgeDocumentDetail>(`/documents/${s.doc.id}`);
    expect(body.document).toMatchObject({ status: 'live', proposals: { pending: 0 } });
  });

  it('replace redoes the reading; delete can take the approved data with it', async () => {
    const s = await reviewed();
    await s.post(`/proposals/${s.m2.id}`, { action: 'approve' });
    const replaced = await s.upload(
      'tabela-v2.csv',
      CSV,
      s.admin.token,
      'PUT',
      `/documents/${s.doc.id}`,
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ status: 'processing', name: 'tabela-v2.csv' });
    expect([...s.files.files.keys()]).toEqual([`acme/${s.doc.id}/tabela-v2.csv`]);
    await s.t.queue.drain();
    const after = (await s.get<KnowledgeDocumentDetail>(`/documents/${s.doc.id}`)).body;
    // The approved proposal stays; the pending ones were proposed again.
    expect(after.document.proposals).toMatchObject({ approved: 1 });
    expect(s.fake.requests).toHaveLength(2);

    const del = await s.t.call(`${s.base}/documents/${s.doc.id}?removeData=true`, s.admin.token, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect(s.files.files.size).toBe(0);
    expect(await extraOf(s.t.db, 'VIN-SPC-CN')).toEqual({});
    expect((await s.get(`/documents/${s.doc.id}`)).status).toBe(404);
  });

  it('keeps each client to its own documents', async () => {
    const s = await reviewed();
    expect((await s.get(`/documents/${s.doc.id}`, s.otherAdmin.token)).status).toBe(403);
    const otherBase = '/api/admin/clients/other/knowledge';
    const r = await s.t.call(`${otherBase}/documents/${s.doc.id}`, s.otherAdmin.token);
    expect(r.status).toBe(404);
    const p = await s.t.call(`${otherBase}/proposals/${s.m2.id}`, s.otherAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(p.status).toBe(404);
    const list = await s.t.call(`${otherBase}/documents`, s.otherAdmin.token);
    expect(await list.json()).toEqual([]);
  });
});

function m2Current(p: KnowledgeProposalView) {
  return p.current;
}

describe('search_documents', () => {
  it('ranks the passage that matches every term first, live documents of the client only', async () => {
    const s = await setup();
    const db = s.t.db;
    await seedDocument(db, 'acme', {
      name: 'Ficha técnica Deck WPC Antracite.pdf',
      passages: [
        { label: 'Página 1', text: 'Deck compósito WPC antracite. Régua 2200 x 146 x 23 mm.' },
        {
          label: 'Página 2',
          text: 'Instalação: espaçamento máximo entre barrotes de 35 cm. Junta de dilatação de 5 mm.',
        },
      ],
    });
    await seedDocument(db, 'acme', {
      name: 'Catálogo geral.pdf',
      passages: [{ text: 'Os nossos decks de madeira e de WPC para exterior.' }],
    });
    await seedDocument(db, 'other', {
      name: 'Outra ficha.pdf',
      passages: [{ text: 'Espaçamento entre barrotes do deck WPC: 40 cm.' }],
    });

    const hits = await searchPassages(db, 'acme', 'espaçamento barrotes deck WPC');
    expect(hits[0]).toMatchObject({
      documentName: 'Ficha técnica Deck WPC Antracite.pdf',
      page: 2,
    });
    expect(hits.map((h) => h.documentName)).not.toContain('Outra ficha.pdf');
    // Nothing matches every term: any-term matches still come back.
    const loose = await searchPassages(db, 'acme', 'barrotes inexistentesxyz');
    expect(loose[0]?.page).toBe(2);
    expect(await searchPassages(db, 'acme', 'telhado')).toEqual([]);

    // A document waiting for review (or still being read) is not searched yet.
    const pending = await seedDocument(db, 'acme', {
      name: 'nova.csv',
      passages: [{ text: 'Barrotes de alumínio' }],
    });
    await db.update(documents).set({ status: 'needs_review' }).where(eq(documents.id, pending));
    expect(await searchPassages(db, 'acme', 'alumínio')).toEqual([]);

    const tool = await searchDocumentsTool.run(
      searchDocumentsTool.inputSchema.parse({ query: 'espaçamento entre barrotes' }),
      toolContext(db, s.client),
    );
    expect((tool as { results: unknown[] }).results[0]).toMatchObject({
      document: 'Ficha técnica Deck WPC Antracite',
      page: 2,
    });
  });

  it('names the document without its extension', () => {
    expect(documentTitle('ficha-tecnica_deck.pdf')).toBe('ficha-tecnica deck');
    expect(documentTitle('Tabela 2026.xlsx')).toBe('Tabela 2026');
  });
});
