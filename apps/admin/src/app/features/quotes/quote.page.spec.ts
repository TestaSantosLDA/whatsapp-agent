import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { computeQuoteTotals, type QuoteDetail } from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { json } from '../../testing';
import { LeadQuotes } from './lead-quotes';
import { QuotePage } from './quote.page';
import { decimalText, longDate, parseDecimal } from './quotes.data';

const lines = [
  {
    variantId: 'deck-1',
    sku: 'DECK-CUM-21',
    description: 'Deck Cumaru 21x145 (32,4 m²)',
    quantity: 27,
    unit: 'cx',
    unitPrice: 58.439,
    discountPercent: 0,
    vatPercent: 23,
  },
];

const quote = (o: Partial<QuoteDetail> = {}): QuoteDetail => {
  const q = {
    id: 'q1',
    number: 'JUL-2026-0042',
    status: 'draft' as const,
    leadId: 'l1',
    branchId: 'maia',
    branchName: 'Norte (Maia)',
    customer: {
      name: 'Carla Sousa',
      company: null,
      nif: null,
      email: 'carla@example.pt',
      phone: '+351912345678',
      address: 'Gaia',
    },
    lines,
    discount: null,
    validUntil: '2026-11-22',
    fulfilment: null,
    notes: null,
    defaultVatPercent: 23,
    canSendWhatsapp: true,
    sends: [],
    createdBy: { id: 'm1', name: 'Rita', email: 'rita@example.pt' },
    createdAt: '2026-10-23T09:00:00.000Z',
    updatedAt: '2026-10-23T09:00:00.000Z',
    sentAt: null,
    ...o,
  };
  return { ...q, totals: computeQuoteTotals(q.lines, q.discount) } as QuoteDetail;
};

describe('quote helpers', () => {
  it('reads and writes numbers the Portuguese way', () => {
    expect(parseDecimal('58,439')).toBe(58.439);
    expect(parseDecimal(' 1 234,5 ')).toBe(1234.5);
    expect(parseDecimal('')).toBeNaN();
    expect(decimalText(58.439)).toBe('58,439');
    expect(decimalText(NaN)).toBe('');
    expect(longDate('2026-11-22')).toBe('22/11/2026');
  });
});

describe('Orçamento', () => {
  let requests: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (url.includes('/quotes?lead=')) return json([]);
        if (method === 'POST' && url.endsWith('/quotes')) return json(quote(), 201);
        if (method === 'PUT') return json(quote(body));
        if (method === 'POST' && url.endsWith('/send')) {
          return json(
            quote({
              ...(requests.find((r) => r.method === 'PUT')?.body as Partial<QuoteDetail>),
              status: 'sent',
              sentAt: '2026-10-23T09:05:00.000Z',
              sends: [
                {
                  channel: body.channel,
                  to: body.channel === 'email' ? body.email : '+351912345678',
                  at: '2026-10-23T09:05:00.000Z',
                  by: { id: 'm1', name: 'Rita', email: 'rita@example.pt' },
                },
              ],
            }),
          );
        }
        return json(quote());
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

  const button = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;

  it('creates a quote from the lead page and opens it', async () => {
    const { fixture, el } = await render(LeadQuotes, { leadId: 'l1' });
    expect(el.textContent).toContain('Ainda sem orçamentos');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    button(el, 'Criar orçamento').click();
    await fixture.whenStable();
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/admin/clients/jular/quotes',
      body: { leadId: 'l1' },
    });
    expect(navigate).toHaveBeenCalledWith(['/quotes', 'q1']);
  });

  it('shows the prefilled lines with totals, recomputed live while editing', async () => {
    const { fixture, el } = await render(QuotePage, { id: 'q1' });
    expect(el.querySelector('h1')!.textContent).toContain('Orçamento JUL-2026-0042');
    const total = () => el.querySelector('[data-testid="total"]')!.textContent!.trim();
    expect(total()).toBe('1 940,76 €');

    const discount = el.querySelectorAll<HTMLInputElement>('.qline input')[4]!; // Desc. %
    discount.value = '10';
    discount.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    // 1577,85 − 157,79 = 1420,06 + 23 % = 1746,67
    expect(total()).toBe('1 746,67 €');

    button(el, 'Guardar').click();
    await fixture.whenStable();
    const put = requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe('/api/admin/clients/jular/quotes/q1');
    expect((put.body as { lines: { discountPercent: number }[] }).lines[0]!.discountPercent).toBe(
      10,
    );
    fixture.detectChanges();
    expect(el.textContent).toContain('Orçamento guardado.');
  });

  it('adds and removes lines', async () => {
    const { fixture, el } = await render(QuotePage, { id: 'q1' });
    button(el, '+ Adicionar linha').click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.qline')).toHaveLength(2);
    expect(el.querySelectorAll<HTMLInputElement>('.qline')[1]!.querySelector('input')!.value).toBe(
      '',
    );
    button(el, 'Remover').click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.qline')).toHaveLength(1);
  });

  it('sends by WhatsApp after saving the edits, then locks the quote', async () => {
    const { fixture, el } = await render(QuotePage, { id: 'q1' });
    const notes = el.querySelector<HTMLTextAreaElement>('textarea')!;
    notes.value = 'Entrega em 2 semanas.';
    notes.dispatchEvent(new Event('input'));
    button(el, 'Enviar por WhatsApp').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const methods = requests.map((r) => `${r.method} ${r.url.split('/jular')[1]}`);
    expect(methods.slice(-2)).toEqual(['PUT /quotes/q1', 'POST /quotes/q1/send']);
    expect(requests.at(-1)!.body).toEqual({ channel: 'whatsapp' });
    expect(el.textContent).toContain('Enviado para o WhatsApp do cliente');
    expect(el.textContent).toContain('WhatsApp para +351912345678');
    expect(el.querySelector<HTMLInputElement>('.qline input')!.disabled).toBe(true);
    expect(button(el, 'Guardar')).toBeUndefined();
  });

  it('sends by email to the address typed', async () => {
    const { fixture, el } = await render(QuotePage, { id: 'q1' });
    const email = el.querySelector<HTMLInputElement>('input[aria-label="Email do cliente"]')!;
    expect(email.value).toBe('carla@example.pt');
    email.value = 'compras@empresa.pt';
    email.dispatchEvent(new Event('input'));
    button(el, 'Enviar por email').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.at(-1)!.body).toEqual({ channel: 'email', email: 'compras@empresa.pt' });
    expect(el.textContent).toContain('Enviado por email para compras@empresa.pt');
  });
});
