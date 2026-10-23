import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  AdminContextView,
  GapsView,
  OverviewFigures,
  OverviewProductsView,
  OverviewView,
} from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { json } from '../../testing';
import { duration } from './overview.format';
import { OverviewPage } from './overview.page';

const figures = (o: Partial<OverviewFigures> = {}): OverviewFigures => ({
  from: '2026-10-18T23:00:00.000Z',
  to: '2026-10-21T10:00:00.000Z',
  conversations: 4,
  leads: 1,
  leadsByType: [{ key: 'quote', label: 'Orçamento', count: 1 }],
  handoffs: 2,
  handoffsByReason: [
    { key: 'could_not_help', label: 'Faltava informação', count: 1 },
    { key: 'customer_asked', label: 'O cliente pediu uma pessoa', count: 1 },
  ],
  quoted: 0,
  quotesSent: 1,
  won: 1,
  lost: 0,
  lostByReason: [],
  firstResponse: { answered: 1, waiting: 2, medianMinutes: 90, medianWorkingMinutes: 90 },
  cost: { turns: 5, agentUsd: 0.12, documentsUsd: 0.02, totalUsd: 0.14 },
  ...o,
});

const view = (o: Partial<OverviewView> = {}): OverviewView => ({
  generatedAt: '2026-10-21T10:00:00.000Z',
  timezone: 'Europe/Lisbon',
  branch: null,
  week: figures(),
  month: figures({ conversations: 40, leads: 12 }),
  branches: [
    {
      branchId: 'lisboa',
      name: 'Lisboa',
      week: { leads: 1, handoffs: 2, won: 1, lost: 0 },
      month: { leads: 9, handoffs: 3, won: 2, lost: 1 },
    },
    {
      branchId: 'porto',
      name: 'Porto',
      week: { leads: 0, handoffs: 0, won: 0, lost: 0 },
      month: { leads: 3, handoffs: 0, won: 0, lost: 0 },
    },
  ],
  ...o,
});

const gaps: GapsView = {
  from: '2026-09-21T10:00:00.000Z',
  to: '2026-10-21T10:00:00.000Z',
  total: 2,
  topics: [
    {
      topic: 'Deck',
      count: 1,
      lastAt: '2026-10-21T10:04:00.000Z',
      reasons: { deferred: 0, handoff: 1, no_result: 1 },
      examples: [
        {
          at: '2026-10-21T10:04:00.000Z',
          question: 'Qual o espaçamento das vigas do deck?',
          reasons: ['no_result', 'handoff'],
          reply: null,
          conversationId: 'c3',
        },
      ],
    },
    {
      topic: 'Outros',
      count: 1,
      lastAt: '2026-10-21T10:01:00.000Z',
      reasons: { deferred: 1, handoff: 0, no_result: 1 },
      examples: [
        {
          at: '2026-10-21T10:01:00.000Z',
          question: 'Vendem telhas cerâmicas?',
          reasons: ['no_result', 'deferred'],
          reply: 'Vou confirmar com um colega.',
          conversationId: 'c1',
        },
      ],
    },
  ],
};

const products: OverviewProductsView = {
  from: gaps.from,
  to: gaps.to,
  products: [{ productId: 'p1', title: 'Deck de Ipê 21 mm', conversations: 3, mentions: 5 }],
  missingSearches: [{ query: 'telha cerâmica', searches: 2, conversations: 2, lastAt: gaps.to }],
};

describe('overview screen', () => {
  let requests: { method: string; url: string; body: unknown }[];

  function setup(role: 'admin' | 'sales') {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url.includes('/overview/gaps/dismiss')) return new Response(null, { status: 204 });
        if (url.includes('/overview/gaps')) return json(gaps);
        if (url.includes('/overview/products')) return json(products);
        if (url.includes('/overview?branch=porto')) {
          return json(view({ branch: 'porto', week: figures({ conversations: 0, cost: null }) }));
        }
        if (url.endsWith('/overview')) return json(view());
        return json({}, 404);
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AdminApi).clientId = 'acme';
    TestBed.inject(SessionStore).context.set({
      role,
      client: { id: 'acme', name: 'Acme', timezone: 'Europe/Lisbon' },
      branches: [
        { id: 'lisboa', name: 'Lisboa' },
        { id: 'porto', name: 'Porto' },
      ],
    } as AdminContextView);
  }
  afterEach(() => vi.unstubAllGlobals());

  async function render() {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const tiles = (el: HTMLElement) =>
    Object.fromEntries(
      [...el.querySelectorAll('.tile')].map((t) => [
        t.querySelector('.tile__label')?.textContent?.trim(),
        t.querySelector('.tile__value')?.textContent?.trim(),
      ]),
    );

  it('shows this week, switches to the month and filters a branch', async () => {
    setup('admin');
    const { fixture, el } = await render();
    expect(tiles(el)).toMatchObject({
      Conversas: '4',
      Pedidos: '1',
      'Passagens para a equipa': '2',
      Ganhos: '1',
      '1.ª resposta da equipa': '1 h 30 min',
    });
    expect(tiles(el)['Custo do Claude']).toContain('0,14');
    expect(el.textContent).toContain('1 orçamento enviado');
    expect(el.querySelectorAll('.ov-table tbody tr')).toHaveLength(2);

    const month = [...el.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) =>
      b.textContent?.includes('mês'),
    )!;
    month.click();
    fixture.detectChanges();
    expect(tiles(el)).toMatchObject({ Conversas: '40', Pedidos: '12' });

    const select = el.querySelector<HTMLSelectElement>('select')!;
    select.value = 'porto';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.some((r) => r.url.endsWith('/overview?branch=porto'))).toBe(true);
  });

  it('lists what the agent could not answer and dismisses a topic', async () => {
    setup('admin');
    const { fixture, el } = await render();
    const topics = [...el.querySelectorAll('.gap__topic')].map((t) => t.textContent?.trim());
    expect(topics).toEqual(['Deck', 'Outros']);
    expect(el.textContent).toContain('Vendem telhas cerâmicas?');
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.gap__examples a')];
    expect(links.map((a) => a.getAttribute('href'))).toContain('/inbox/c1');
    expect(el.textContent).toContain('Assistente: Vou confirmar com um colega.');
    expect(el.querySelector('.gap__actions a')?.getAttribute('href')).toBe('/knowledge');
    expect(el.textContent).toContain('Deck de Ipê 21 mm');
    expect(el.textContent).toContain('telha cerâmica');

    const ignore = el.querySelector<HTMLButtonElement>('.gap .btn--ghost')!;
    ignore.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/api/admin/clients/acme/overview/gaps/dismiss');
    expect(post.body).toEqual({ topic: 'Deck' });
    expect([...el.querySelectorAll('.gap__topic')].map((t) => t.textContent?.trim())).toEqual([
      'Outros',
    ]);
  });

  it('sales see the figures and products, not the questions', async () => {
    setup('sales');
    const { el } = await render();
    expect(el.querySelector('.tile')).not.toBeNull();
    expect(el.querySelector('.gap')).toBeNull();
    expect(requests.some((r) => r.url.includes('/overview/gaps'))).toBe(false);
    expect(el.textContent).toContain('Produtos mais procurados');
  });

  it('formats durations', () => {
    expect(duration(null)).toBe('—');
    expect(duration(42)).toBe('42 min');
    expect(duration(60)).toBe('1 h');
    expect(duration(3000)).toBe('2 d 2 h');
  });
});
