import { TestBed } from '@angular/core/testing';
import type { BackofficeEvent, SimEvent } from '@wa/shared';
import { App } from './app';
import { EVENT_SOURCE_FACTORY, EventSourceLike } from './core/chat.store';

class FakeEventSource implements EventSourceLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  emit(ev: SimEvent | BackofficeEvent) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(ev) }));
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('App (simulator page)', () => {
  let sources: FakeEventSource[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    sources = [];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/sim/config') return json({ accessCodeRequired: false });
      if (url === '/sim/clients')
        return json([
          { id: 'jular', name: 'Jular Madeiras', displayPhoneNumber: '+351', languages: ['pt-PT'] },
        ]);
      if (url.endsWith('/messages') && init?.method === 'POST') return json({ messageId: 'm1' });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const es = new FakeEventSource(url);
            sources.push(es);
            return es;
          },
        },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function boot() {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('connects to the stream for the first client and the default persona', async () => {
    const { el } = await boot();
    expect(sources.map((s) => s.url)).toEqual([
      '/sim/jular/stream?phone=351912345678',
      '/sim/jular/backoffice?phone=351912345678',
    ]);
    expect(el.querySelector('.chat-head__name')?.textContent).toContain('Jular Madeiras');
    expect(el.querySelector('.panel__title')?.textContent).toContain('Back-office');
  });

  it('shows pushed leads and emails in the back-office panel, trace behind a toggle', async () => {
    const { fixture, el } = await boot();
    const bo = sources.find((s) => s.url.includes('/backoffice'))!;
    bo.emit({
      type: 'snapshot',
      conversationStatus: 'human',
      leads: [],
      emails: [],
      turns: [
        {
          id: 't1',
          createdAt: '2026-10-22T10:00:00Z',
          model: 'claude-test',
          inputTokens: 1200,
          outputTokens: 80,
          cacheReadTokens: 1000,
          costUsd: 0.0012,
          latencyMs: 900,
          error: null,
          toolCalls: [{ name: 'search_products', input: { query: 'deck' }, ok: true, ms: 12 }],
        },
      ],
    });
    bo.emit({
      type: 'lead',
      lead: {
        id: 'l1',
        createdAt: '2026-10-22T10:00:01Z',
        type: 'quote',
        branchId: 'porto',
        branchName: 'Porto',
        status: 'new',
        fields: { name: 'Ana Costa', area: '40 m2' },
      },
    });
    bo.emit({
      type: 'email',
      email: {
        id: 'e1',
        createdAt: '2026-10-22T10:00:02Z',
        kind: 'lead',
        to: ['porto@jular.test'],
        subject: 'Novo pedido de orçamento',
        body: 'A Ana quer 40 m2 de deck.',
        sentAt: null,
        error: null,
      },
    });
    await fixture.whenStable();

    expect(el.querySelector('.badge')?.textContent).toContain('Humano');
    expect(el.querySelector('.bo__bot-btn')?.textContent).toContain('Devolver ao bot');
    const card = el.querySelector('.lead')!;
    expect(card.textContent).toContain('Pedido de orçamento');
    expect(card.textContent).toContain('Porto');
    expect(card.textContent).toContain('40 m2');

    expect(el.querySelector('.mail__text')).toBeNull();
    (el.querySelector('.mail__row') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('.mail__text')?.textContent).toContain('40 m2 de deck');

    expect(el.querySelector('.turn')).toBeNull();
    const toggle = el.querySelector('.bo__switch input') as HTMLInputElement;
    toggle.click();
    await fixture.whenStable();
    expect(el.querySelector('.turn')?.textContent).toContain('search_products');
    expect(localStorage.getItem('wa-sim.showTrace')).toBe('1');
  });

  it('renders streamed messages, typing and a tappable button reply', async () => {
    const { fixture, el } = await boot();
    const es = sources[0];
    es.onopen?.(new Event('open'));
    es.emit({ type: 'history', messages: [], conversationStatus: 'bot' });
    es.emit({ type: 'typing', on: true });
    await fixture.whenStable();
    expect(el.querySelector('.chat-head__status')?.textContent).toContain('a escrever…');

    es.emit({
      type: 'message',
      message: {
        id: 'o1',
        direction: 'outbound',
        timestamp: '2026-10-21T10:00:00Z',
        payload: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '351912345678',
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Em que podemos ajudar?' },
            action: {
              buttons: [{ type: 'reply', reply: { id: 'quote', title: 'Pedir orçamento' } }],
            },
          },
        },
      },
    });
    await fixture.whenStable();
    expect(el.querySelector('.chat-head__status')?.textContent).toContain('online');
    const btn = el.querySelector('.reply-button') as HTMLButtonElement;
    expect(btn.textContent).toContain('Pedir orçamento');

    btn.click();
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/messages'));
    expect(call?.[0]).toBe('/sim/jular/messages');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      phone: '351912345678',
      name: 'Ana Costa',
      reply: { type: 'button_reply', id: 'quote', title: 'Pedir orçamento' },
    });
  });
});
