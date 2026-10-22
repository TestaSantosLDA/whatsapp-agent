import { TestBed } from '@angular/core/testing';
import type { BackofficeEmail, BackofficeLead, BackofficeTurn } from '@wa/shared';
import { BackofficeStore } from './backoffice.store';
import { ChatStore, EVENT_SOURCE_FACTORY, EventSourceLike } from './chat.store';

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
}

const lead = (id: string, over: Partial<BackofficeLead> = {}): BackofficeLead => ({
  id,
  createdAt: '2026-10-22T10:00:00Z',
  type: 'quote',
  branchId: 'lisboa',
  branchName: 'Lisboa',
  status: 'new',
  fields: { name: 'Ana' },
  ...over,
});
const email = (id: string): BackofficeEmail => ({
  id,
  createdAt: '2026-10-22T10:00:01Z',
  kind: 'lead',
  to: ['lisboa@acme.test'],
  subject: 'Novo pedido',
  body: 'corpo',
  sentAt: null,
  error: null,
});
const turn = (id: string): BackofficeTurn => ({
  id,
  createdAt: '2026-10-22T10:00:02Z',
  model: 'claude-test',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 80,
  costUsd: 0.001,
  latencyMs: 500,
  error: null,
  toolCalls: [],
});

describe('BackofficeStore', () => {
  let store: BackofficeStore;
  let chat: ChatStore;
  let sources: FakeEventSource[];

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    sources = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const es = new FakeEventSource(url);
            // The chat store connects too; keep only the panel's stream.
            if (url.includes('/backoffice')) sources.push(es);
            return es;
          },
        },
      ],
    });
    store = TestBed.inject(BackofficeStore);
    chat = TestBed.inject(ChatStore);
  });

  it('replaces everything on a snapshot and dedupes it by id', () => {
    store.handleEvent({ type: 'lead', lead: lead('old') });
    store.handleEvent({
      type: 'snapshot',
      conversationStatus: 'human',
      leads: [lead('a'), lead('a', { status: 'sent' })],
      emails: [email('e')],
      turns: [turn('t')],
    });
    expect(store.leads().map((l) => [l.id, l.status])).toEqual([['a', 'sent']]);
    expect(store.emails().map((e) => e.id)).toEqual(['e']);
    expect(store.turns().map((t) => t.id)).toEqual(['t']);
    expect(store.status()).toBe('human');
  });

  it('appends live events and dedupes those already in the snapshot', () => {
    store.handleEvent({
      type: 'snapshot',
      conversationStatus: 'bot',
      leads: [lead('a')],
      emails: [],
      turns: [],
    });
    store.handleEvent({ type: 'lead', lead: lead('a', { type: 'order' }) });
    store.handleEvent({ type: 'lead', lead: lead('b') });
    store.handleEvent({ type: 'email', email: email('e') });
    store.handleEvent({ type: 'email', email: email('e') });
    store.handleEvent({ type: 'turn', turn: turn('t') });
    store.handleEvent({ type: 'conversation', status: 'human' });
    expect(store.leads().map((l) => [l.id, l.type])).toEqual([
      ['a', 'order'],
      ['b', 'quote'],
    ]);
    expect(store.emails()).toHaveLength(1);
    expect(store.turns()).toHaveLength(1);
    expect(store.status()).toBe('human');
  });

  it('connects for the current client and persona and starts over when they change', () => {
    chat.phase.set('ready');
    chat.clientId.set('acme');
    TestBed.tick();
    expect(sources.map((s) => s.url)).toEqual(['/sim/acme/backoffice?phone=351912345678']);

    store.handleEvent({ type: 'lead', lead: lead('a') });
    chat.selectPersona({ id: 'john', name: 'John Miller', phone: '447700900123', lang: 'en' });
    TestBed.tick();
    expect(sources[0].closed).toBe(true);
    expect(sources[1].url).toBe('/sim/acme/backoffice?phone=447700900123');
    expect(store.leads()).toEqual([]);

    store.handleEvent({ type: 'lead', lead: lead('b') });
    chat.session.update((n) => n + 1);
    TestBed.tick();
    expect(sources).toHaveLength(3);
    expect(store.leads()).toEqual([]);
  });

  it('remembers whether the trace is shown, hidden by default', () => {
    expect(store.showTrace()).toBe(false);
    store.setShowTrace(true);
    expect(localStorage.getItem('wa-sim.showTrace')).toBe('1');
    store.setShowTrace(false);
    expect(localStorage.getItem('wa-sim.showTrace')).toBeNull();
  });

  it('says so when the server cannot return the conversation to the bot yet', async () => {
    chat.clientId.set('acme');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    store.handleEvent({ type: 'conversation', status: 'human' });
    await store.returnToBot();
    expect(store.status()).toBe('human');
    expect(store.notice()).toMatch(/ainda não permite/);
    vi.unstubAllGlobals();
  });
});
