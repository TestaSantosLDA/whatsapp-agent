import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PrivacyCustomer, PrivacyRequestView } from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { json } from '../../testing';
import { formatCounts, formatPhone } from './privacy.format';
import { PrivacyHomePage } from './privacy-home.page';
import { PrivacyRequestsPage } from './requests.page';

const ana: PrivacyCustomer = {
  contactId: 'c-ana',
  name: 'Ana Quintela',
  phone: '351911222333',
  createdAt: '2026-01-10T10:00:00Z',
  lastActivityAt: '2026-10-20T10:00:00Z',
  conversations: 2,
  leads: 1,
  profilingOptOut: false,
  pendingRequests: 1,
};
const request: PrivacyRequestView = {
  id: 'r-1',
  type: 'delete',
  status: 'pending',
  source: 'whatsapp',
  customer: { contactId: ana.contactId, name: ana.name, phone: ana.phone },
  createdAt: '2026-10-21T09:00:00Z',
  decidedAt: null,
  decidedBy: null,
  result: null,
};

let requests: { method: string; url: string; body: unknown }[];
let answer: (method: string, url: string, body: unknown) => Response;

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      return answer(method, url, body);
    }),
  );
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  TestBed.inject(AdminApi).clientId = 'jular';
});
afterEach(() => vi.unstubAllGlobals());

const settle = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('PrivacyHomePage', () => {
  it('deletes a customer only after their name is typed', async () => {
    answer = (method, url) => {
      if (url.includes('/requests')) return json([request]);
      if (method === 'POST') return json({ counts: { contacts: 1, messages: 12 } });
      return json([ana]);
    };
    const fixture = TestBed.createComponent(PrivacyHomePage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(requests.map((r) => r.url)).toEqual([
      '/api/admin/clients/jular/privacy/customers?q=',
      '/api/admin/clients/jular/privacy/requests?status=pending',
    ]);
    expect(el.textContent).toContain('Há 1 pedido de clientes por tratar');

    el.querySelector<HTMLButtonElement>('.result')!.click();
    fixture.detectChanges();
    expect(el.textContent).toContain('+351 911 222 333');
    const button = (label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === label,
      )!;
    button('Apagar cliente').click();
    fixture.detectChanges();
    const confirmButton = button('Apagar definitivamente');
    expect(confirmButton.disabled).toBe(true);
    const input = el.querySelector<HTMLInputElement>('#privacy-confirm')!;
    type(input, 'Ana');
    fixture.detectChanges();
    expect(confirmButton.disabled).toBe(true);
    type(input, 'ana quintela');
    fixture.detectChanges();
    expect(confirmButton.disabled).toBe(false);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);

    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: '/api/admin/clients/jular/privacy/customers/c-ana/delete',
      body: { confirm: 'ana quintela' },
    });
    expect(el.textContent).toContain('Cliente apagado: 1 contacto · 12 mensagens.');
    expect(el.querySelector('.result')).toBeNull();
  });
});

describe('PrivacyRequestsPage', () => {
  it('approves a WhatsApp deletion request with the typed number', async () => {
    let pending = [request];
    answer = (method) => {
      if (method === 'POST') {
        pending = [];
        return json({ counts: { contacts: 1 }, notified: true });
      }
      return json(pending);
    };
    const fixture = TestBed.createComponent(PrivacyRequestsPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(requests[0]!.url).toBe('/api/admin/clients/jular/privacy/requests?status=pending');
    expect(el.textContent).toContain('Apagar dados');
    expect(el.textContent).toContain('Pedido no WhatsApp');
    const approve = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Aprovar e apagar',
    )!;
    expect(approve.disabled).toBe(true);
    type(el.querySelector<HTMLInputElement>('label input')!, '911 222 333');
    fixture.detectChanges();
    expect(approve.disabled).toBe(false);
    approve.click();
    await settle(fixture);
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post).toEqual({
      method: 'POST',
      url: '/api/admin/clients/jular/privacy/requests/r-1/approve',
      body: { confirm: '911 222 333' },
    });
    expect(el.textContent).toContain('O cliente foi avisado no WhatsApp.');
    expect(el.textContent).toContain('Não há pedidos por tratar.');
  });
});

describe('privacy format', () => {
  it('formats counts and numbers', () => {
    expect(formatCounts({ messages: 3, leads_anonymised: 1, emails: 0 })).toBe(
      '3 mensagens · 1 pedido anonimizado',
    );
    expect(formatCounts({})).toBe('sem alterações');
    expect(formatPhone('351911222333')).toBe('+351 911 222 333');
    expect(formatPhone('447700900123')).toBe('+447700900123');
  });
});
