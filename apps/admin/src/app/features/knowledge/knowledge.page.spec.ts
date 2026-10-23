import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  AdminContextView,
  KnowledgeDocumentDetail,
  KnowledgeDocumentView,
  KnowledgeProposalView,
} from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { json } from '../../testing';
import { DocumentPage, markQuote } from './document.page';
import { KnowledgePage } from './knowledge.page';

const doc = (over: Partial<KnowledgeDocumentView> = {}): KnowledgeDocumentView => ({
  id: 'd1',
  name: 'Ficha técnica Vinílico SPC.pdf',
  type: 'pdf',
  sizeBytes: 482_000,
  status: 'needs_review',
  error: null,
  uploadedBy: 'admin@jular.pt',
  createdAt: '2026-10-22T10:00:00Z',
  updatedAt: '2026-10-22T10:01:00Z',
  passages: 2,
  proposals: { pending: 1, approved: 0, rejected: 0 },
  costUsd: 0.021,
  model: 'claude-opus-5-5',
  ...over,
});

const proposal: KnowledgeProposalView = {
  id: 'p1',
  page: 2,
  productKey: 'VIN-SPC-CN',
  productLabel: 'Pavimento Vinílico SPC Carvalho Natural',
  field: 'm2_per_box',
  value: 2.5,
  finalValue: null,
  confidence: 0.92,
  quote: 'Caixa: 2,5 m²',
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  current: 2.2,
};

const detail: KnowledgeDocumentDetail = {
  document: doc(),
  proposals: [proposal],
  passages: [
    { page: 1, label: 'Página 1', text: 'Pavimento vinílico SPC.' },
    { page: 2, label: 'Página 2', text: 'Embalagem. Caixa: 2,5 m² (10 réguas).' },
  ],
};

describe('knowledge screens', () => {
  let requests: { method: string; url: string; body: unknown }[];

  function setup(role: 'admin' | 'sales') {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body =
          init?.body instanceof FormData
            ? init.body
            : init?.body
              ? JSON.parse(String(init.body))
              : undefined;
        requests.push({ method, url, body });
        if (url.endsWith('/knowledge/documents') && method === 'GET') {
          return json([doc(), doc({ id: 'd2', name: 'Tabela.csv', type: 'csv', status: 'live' })]);
        }
        if (url.endsWith('/knowledge/documents') && method === 'POST') {
          return json(doc({ id: 'd3', name: 'novo.csv', type: 'csv', status: 'live' }), 201);
        }
        if (url.endsWith('/knowledge/proposals/p1')) {
          return json({ ...proposal, status: 'approved', finalValue: 2.5, current: 2.5 });
        }
        if (url.endsWith('/knowledge/documents/d1')) return json(detail);
        return json({}, 404);
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AdminApi).clientId = 'jular';
    TestBed.inject(SessionStore).context.set({ role } as AdminContextView);
  }
  afterEach(() => vi.unstubAllGlobals());

  it('lists documents with their status; admins get the drop zone and upload as multipart', async () => {
    setup('admin');
    const fixture = TestBed.createComponent(KnowledgePage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const statuses = [...el.querySelectorAll('.status')].map((s) => s.textContent?.trim());
    expect(statuses).toEqual(['Para rever (1)', 'Ativo']);
    expect(el.querySelector('.dropzone')).not.toBeNull();

    const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['a;b\n1;2'], 'novo.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/api/admin/clients/jular/knowledge/documents');
    expect((post.body as FormData).get('file')).toBeInstanceOf(File);
    expect(el.querySelectorAll('.kb-doc')).toHaveLength(3);
  });

  it('hides the drop zone from sales', async () => {
    setup('sales');
    const fixture = TestBed.createComponent(KnowledgePage);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.dropzone')).toBeNull();
  });

  it('shows a proposal next to its source and approves it', async () => {
    setup('admin');
    const fixture = TestBed.createComponent(DocumentPage);
    fixture.componentRef.setInput('id', 'd1');
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.proposal__number')?.textContent?.trim()).toBe('2,5 m²');
    expect(el.textContent).toContain('Atual: 2,2 m²');
    expect(el.querySelectorAll('.passage')).toHaveLength(2);

    el.querySelector<HTMLElement>('.proposal')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.passage--selected mark')?.textContent).toBe('Caixa: 2,5 m²');

    const approve = [...el.querySelectorAll<HTMLButtonElement>('.proposal__actions button')].find(
      (b) => b.textContent?.trim() === 'Aprovar',
    )!;
    approve.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post).toMatchObject({
      url: '/api/admin/clients/jular/knowledge/proposals/p1',
      body: { action: 'approve' },
    });
    expect(el.textContent).toContain('Aprovado');
  });

  it('marks the quote inside the passage, ignoring case', () => {
    expect(markQuote('Caixa: 2,5 m² (10)', 'caixa: 2,5 m²')).toEqual({
      before: '',
      mark: 'Caixa: 2,5 m²',
      after: ' (10)',
    });
    expect(markQuote('abc', 'zzz')).toEqual({ before: 'abc', mark: '', after: '' });
  });
});
