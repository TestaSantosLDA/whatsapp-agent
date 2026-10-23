import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminLeadDetail, AdminLeadList, AdminLeadListItem } from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { json } from '../../testing';
import { LeadPage } from './lead.page';
import {
  emptyFilters,
  LeadsData,
  leadsQuery,
  nextStatuses,
  shortBranch,
  waitingLabel,
} from './leads.data';
import { LeadsPage } from './leads.page';

const item = (o: Partial<AdminLeadListItem> = {}): AdminLeadListItem => ({
  id: 'l1',
  createdAt: '2026-10-09T16:30:00.000Z',
  type: 'quote',
  branchId: 'maia',
  branchName: 'Norte (Maia)',
  status: 'new',
  lostReason: null,
  owner: { id: 'm1', name: 'Rita', email: 'rita@example.pt' },
  name: 'Carla Sousa',
  phone: '+351912345678',
  summary: 'Deck de 30 m² em Gaia',
  products: 'Deck de pinho',
  conversationId: 'c1',
  waitingHours: 9.5,
  overdue: true,
  ...o,
});

const detail = (o: Partial<AdminLeadDetail> = {}): AdminLeadDetail => ({
  ...item(),
  fields: { summary: 'Deck de 30 m² em Gaia', location: 'Gaia', email: 'carla@example.pt' },
  attachments: [{ type: 'image', messageId: 'w1', mediaId: 'm1', caption: 'planta' }],
  contact: { id: 'k1', name: 'Carla', waId: '351912345678' },
  contactedAt: null,
  quotedAt: null,
  closedAt: null,
  ownerRemindedAt: null,
  adminRemindedAt: null,
  responseTimeHours: 8,
  notes: [],
  events: [
    {
      id: 'e1',
      kind: 'created',
      actor: null,
      data: { owner: 'm1', ownerName: 'Rita', rule: 'round_robin' },
      createdAt: '2026-10-09T16:30:00.000Z',
    },
  ],
  owners: [
    { id: 'm1', name: 'Rita', email: 'rita@example.pt' },
    { id: 'm2', name: 'Rui', email: 'rui@example.pt' },
  ],
  ...o,
});

describe('leads helpers', () => {
  it('builds the query string and the one-tap next steps', () => {
    expect(leadsQuery(emptyFilters())).toBe('');
    expect(
      leadsQuery(
        { q: ' deck ', status: ['new', 'contacted'], type: 'order', branch: 'maia', owner: 'me' },
        { limit: 50, offset: 50 },
      ),
    ).toBe('?q=deck&status=new%2Ccontacted&type=order&branch=maia&owner=me&limit=50&offset=50');
    expect(nextStatuses('new')).toEqual(['contacted', 'quoted', 'lost']);
    expect(nextStatuses('won')).toEqual([]);
    expect(waitingLabel(3.46)).toBe('3,5 h úteis');
    expect(waitingLabel(26.4)).toBe('26 h úteis');
    expect(shortBranch('Lisboa (Camarate) — loja e ponto de recolha')).toBe('Lisboa (Camarate)');
    expect(shortBranch('Azambuja (Sede, Fábrica e Departamento Técnico)')).toBe('Azambuja');
    expect(shortBranch(null)).toBe('Sem filial');
  });
});

describe('Pedidos', () => {
  let requests: { method: string; url: string; body: unknown }[];
  let list: AdminLeadList;

  beforeEach(() => {
    requests = [];
    list = {
      items: [
        item(),
        item({ id: 'l2', name: 'Paulo', status: 'quoted', waitingHours: null, overdue: false }),
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (url.endsWith('/team')) return json([]);
        if (url.includes('/quotes?lead=')) return json([]); // WA-025's card on the lead page
        if (method === 'PATCH' && url.endsWith('/status')) return json(detail({ ...body }));
        if (method === 'PATCH' && url.endsWith('/owner')) {
          return json(detail({ owner: { id: 'm2', name: 'Rui', email: 'rui@example.pt' } }));
        }
        if (method === 'POST') return json({ id: 'n1', body: body.body }, 201);
        if (url.includes('/leads/l1')) return json(detail());
        return json(list);
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AdminApi).clientId = 'jular';
    TestBed.inject(LeadsData).filters.set(emptyFilters());
  });
  afterEach(() => vi.unstubAllGlobals());

  async function render<T>(component: Type<T>, inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(component);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists leads as cards with their wait, and filters by status', async () => {
    const { fixture, el } = await render(LeadsPage);
    expect(requests[0]!.url).toBe('/api/admin/clients/jular/leads?limit=50&offset=0');
    const cards = el.querySelectorAll('.lcard');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('Carla Sousa');
    expect(cards[0]!.textContent).toContain('Sem resposta há 9,5 h úteis');
    expect(cards[0]!.textContent).toContain('Rita');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);

    const novo = [...el.querySelectorAll<HTMLButtonElement>('.fchip')].find(
      (b) => b.textContent?.trim() === 'Novo',
    )!;
    novo.click();
    await fixture.whenStable();
    expect(requests.at(-1)!.url).toBe(
      '/api/admin/clients/jular/leads?status=new&limit=50&offset=0',
    );
  });

  it('changes a status with one tap, and asks for the reason before "Perdido"', async () => {
    const { fixture, el } = await render(LeadsPage);
    const chips = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('.schip')];
    const card = el.querySelector('.lcard')!;
    chips(card)
      .find((b) => b.textContent?.trim() === 'Contactado')!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/api/admin/clients/jular/leads/l1/status',
      body: { status: 'contacted' },
    });
    expect(card.textContent).toContain('Contactado');

    chips(card)
      .find((b) => b.textContent?.trim() === 'Perdido')!
      .click();
    fixture.detectChanges();
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    chips(card)
      .find((b) => b.textContent?.trim() === 'Preço')!
      .click();
    await fixture.whenStable();
    expect(requests.at(-1)!.body).toEqual({ status: 'lost', lostReason: 'price' });
  });

  it('shows a lead with its fields, notes and activity, and changes the owner', async () => {
    const { fixture, el } = await render(LeadPage, { id: 'l1' });
    expect(requests[0]!.url).toBe('/api/admin/clients/jular/leads/l1');
    expect(el.querySelector('h1')!.textContent).toContain('Carla Sousa');
    expect(el.textContent).toContain('Gaia');
    expect(el.textContent).toContain('carla@example.pt');
    expect(el.textContent).toContain('Imagem: planta');
    expect(el.textContent).toContain(
      'Pedido recebido pelo assistente, atribuído a Rita (por rotação entre os comerciais da filial)',
    );
    expect(el.querySelector('a[href="https://wa.me/351912345678"]')).not.toBeNull();

    const select = el.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('m1');
    select.value = 'm2';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { ownerId: 'm2' } });

    const note = el.querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'Ligar amanhã';
    note.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({
      url: '/api/admin/clients/jular/leads/l1/notes',
      body: { body: 'Ligar amanhã' },
    });
  });
});
