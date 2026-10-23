import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CustomerDetail, CustomerList } from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { json } from '../../testing';
import { CustomerPage } from './customer.page';
import { editorText, formatPhone, parseEditor, profileText } from './customers.data';
import { CustomersPage } from './customers.page';

const detail = (o: Partial<CustomerDetail> = {}): CustomerDetail => ({
  id: 'c1',
  name: null,
  company: 'Mendes Carpintaria',
  nif: null,
  role: 'carpenter',
  regions: [],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  contacts: [
    {
      id: 'k1',
      phone: '351912000111',
      name: 'Carlos Mendes',
      language: 'pt',
      profilingOptOut: false,
      createdAt: '2026-10-01T09:00:00.000Z',
    },
  ],
  conversations: [
    {
      id: 'v1',
      contactId: 'k1',
      status: 'bot',
      createdAt: '2026-10-01T09:00:00.000Z',
      lastActivityAt: '2026-10-01T09:30:00.000Z',
      messages: 4,
      lastText: 'Só preciso do preço.',
    },
  ],
  leads: [
    {
      id: 'l1',
      type: 'order',
      status: 'new',
      branchId: 'lisboa',
      branchName: 'Lisboa',
      createdAt: '2026-10-01T09:20:00.000Z',
      products: 'Deck de pinho × 40',
      summary: null,
    },
  ],
  quotes: [
    {
      id: 'q1',
      number: 'JUL-2026-0001',
      status: 'sent',
      leadId: 'l1',
      branchName: 'Lisboa',
      totalCents: 131600,
      validUntil: '2026-10-31',
      createdAt: '2026-10-02T08:00:00.000Z',
      sentAt: '2026-10-02T09:00:00.000Z',
    },
  ],
  notes: [],
  profile: {
    state: 'on',
    fields: [
      {
        field: 'detail_level',
        value: 'short',
        source: 'agent',
        locked: false,
        evidence: 'só preciso do preço',
        conversationId: 'v1',
        updatedAt: '2026-10-01T09:10:00.000Z',
        updatedBy: null,
      },
      {
        field: 'usual_products',
        value: [{ name: 'Deck de pinho 21x145', variant_id: '4610001', quantity: '40 caixas' }],
        source: 'agent',
        locked: false,
        evidence: 'levo sempre 40 caixas',
        conversationId: 'v1',
        updatedAt: '2026-10-01T09:10:00.000Z',
        updatedBy: null,
      },
    ],
  },
  ...o,
});

describe('customers helpers', () => {
  it('formats numbers and profile values, and parses what the team typed', () => {
    expect(formatPhone('351912000111')).toBe('+351 912 000 111');
    expect(formatPhone('447700900123')).toBe('+447700900123');
    expect(profileText('detail_level', 'short')).toBe('Respostas curtas');
    expect(profileText('negotiates_on_volume', true)).toBe('Sim');
    expect(profileText('delivery', null)).toBe('—');
    const products = [{ name: 'Deck de pinho', variant_id: '1', quantity: '40 caixas' }];
    expect(profileText('usual_products', products)).toBe('Deck de pinho (40 caixas)');
    expect(editorText('usual_products', products)).toBe('Deck de pinho; 40 caixas');
    expect(parseEditor('usual_products', 'deck de pinho; 60 caixas\nÓleo Osmo', products)).toEqual([
      { name: 'deck de pinho', variant_id: '1', quantity: '60 caixas' },
      { name: 'Óleo Osmo' },
    ]);
    expect(parseEditor('job_types', ' decks, , soalhos ', null)).toEqual(['decks', 'soalhos']);
    expect(parseEditor('negotiates_on_volume', 'true', null)).toBe(true);
  });
});

describe('Clientes', () => {
  let requests: { method: string; url: string; body: unknown }[];
  let current: CustomerDetail;

  beforeEach(() => {
    requests = [];
    current = detail();
    const list: CustomerList = {
      items: [
        {
          id: 'c1',
          name: 'Carlos Mendes',
          company: 'Mendes Carpintaria',
          role: 'carpenter',
          phones: ['351912000111'],
          lastActivityAt: '2026-10-01T09:30:00.000Z',
          conversations: 1,
          leads: 1,
          profiling: 'on',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (url.includes('/customers?')) return json(list);
        if (url.endsWith('/profile/clear')) {
          current = detail({ profile: { state: 'opted_out', fields: [] } });
          return json(current);
        }
        if (method === 'PUT') {
          const field = url.split('/').pop()!;
          const others = current.profile.fields.filter((f) => f.field !== field);
          const before = current.profile.fields.find((f) => f.field === field);
          current = detail({
            profile: {
              state: 'on',
              fields: [
                ...others,
                {
                  field: field as 'detail_level',
                  value: body.value ?? before?.value ?? null,
                  source: 'team',
                  locked: body.locked ?? before?.locked ?? false,
                  evidence: null,
                  conversationId: null,
                  updatedAt: '2026-10-02T09:00:00.000Z',
                  updatedBy: 'Rita',
                },
              ],
            },
          });
          return json(current);
        }
        if (method === 'PATCH') return json(detail({ ...body }));
        if (method === 'POST' && url.endsWith('/notes')) {
          return json(
            detail({
              notes: [
                { id: 'n1', body: body.body, author: null, createdAt: '2026-10-02T09:00:00.000Z' },
              ],
            }),
            201,
          );
        }
        return json(current);
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AdminApi).clientId = 'jular';
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

  const button = (el: HTMLElement, text: string, within: ParentNode = el) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;

  it('lists customers and filters by type', async () => {
    const { fixture, el } = await render(CustomersPage);
    expect(requests[0]!.url).toBe('/api/admin/clients/jular/customers?limit=50&offset=0');
    expect(el.querySelector('.ccard')!.textContent).toContain('Carlos Mendes');
    expect(el.querySelector('.ccard')!.textContent).toContain('+351 912 000 111');
    button(el, 'Carpinteiro').click();
    await fixture.whenStable();
    expect(requests.at(-1)!.url).toBe(
      '/api/admin/clients/jular/customers?role=carpenter&limit=50&offset=0',
    );
  });

  it('shows the profile with why, and the team edits and locks a field', async () => {
    const { fixture, el } = await render(CustomerPage, { id: 'c1' });
    expect(el.querySelector('h1')!.textContent).toContain('Carlos Mendes');
    const pref = (field: string) => el.querySelector<HTMLElement>(`[data-field="${field}"]`)!;
    expect(pref('detail_level').textContent).toContain('Respostas curtas');
    expect(pref('detail_level').textContent).toContain('Porquê: «só preciso do preço»');
    expect(pref('detail_level').textContent).toContain('Assistente');
    expect(pref('usual_products').textContent).toContain('Deck de pinho 21x145 (40 caixas)');
    expect(el.textContent).toContain('Deck de pinho × 40');
    const quote = el.querySelector<HTMLAnchorElement>('a[href="/quotes/q1"]')!;
    expect(quote.textContent).toContain('Orçamento JUL-2026-0001');
    expect(quote.closest('li')!.textContent).toContain('Enviado');
    expect(quote.closest('li')!.textContent).toContain('1 316,00 € com IVA');
    expect(el.querySelector('a[href="https://wa.me/351912000111"]')).not.toBeNull();

    button(el, 'Editar', pref('detail_level')).click();
    fixture.detectChanges();
    const select = pref('detail_level').querySelector<HTMLSelectElement>('select')!;
    select.value = 'full';
    select.dispatchEvent(new Event('change'));
    button(el, 'Guardar', pref('detail_level')).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      url: '/api/admin/clients/jular/customers/c1/profile/detail_level',
      body: { value: 'full' },
    });
    expect(pref('detail_level').textContent).toContain('Explicações completas');
    expect(pref('detail_level').textContent).toContain('Equipa');

    button(el, 'Bloquear', pref('delivery')).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { locked: true } });
    expect(pref('delivery').textContent).toContain('Bloqueado');
  });

  it('clears the profile after a confirmation', async () => {
    const { fixture, el } = await render(CustomerPage, { id: 'c1' });
    button(el, 'Apagar perfil e parar a personalização').click();
    fixture.detectChanges();
    expect(requests.some((r) => r.url.endsWith('/profile/clear'))).toBe(false);
    button(el, 'Apagar perfil').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/admin/clients/jular/customers/c1/profile/clear',
    });
    expect(el.textContent).toContain('O cliente opôs-se à personalização');
    expect(el.querySelector('[data-field]')).toBeNull();
  });

  it('saves the record and adds a note', async () => {
    const { fixture, el } = await render(CustomerPage, { id: 'c1' });
    const form = el.querySelectorAll('form')[0]!;
    form.querySelector<HTMLInputElement>('[name="nif"]')!.value = '509999999';
    form.querySelector<HTMLSelectElement>('[name="role"]')!.value = 'builder';
    form.querySelector<HTMLInputElement>('[name="regions"]')!.value = 'Sintra, Cascais';
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(requests.at(-1)).toMatchObject({
      method: 'PATCH',
      body: {
        company: 'Mendes Carpintaria',
        nif: '509999999',
        role: 'builder',
        regions: ['Sintra', 'Cascais'],
      },
    });

    const note = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Nova nota"]')!;
    note.value = 'Paga a pronto';
    note.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    note.closest('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)).toMatchObject({ method: 'POST', body: { body: 'Paga a pronto' } });
    expect(el.textContent).toContain('Paga a pronto');
  });
});
