import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  AdminContextView,
  InboxConversation,
  InboxConversationDetail,
  InboxMessage,
} from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { json } from '../../testing';
import { ConversationPage } from './conversation.page';
import { InboxStore } from './inbox.store';
import { toInboxMessageView } from './message-view';

const ME = '00000000-0000-4000-8000-000000000001';

const row = (over: Partial<InboxConversation> = {}): InboxConversation => ({
  id: 'c1',
  status: 'human',
  contact: { id: 'k1', name: 'Ana', phone: '351911111111' },
  branchId: 'maia',
  branchName: 'Maia',
  assignedTo: null,
  lastActivityAt: '2026-10-22T10:00:00.000Z',
  createdAt: '2026-10-22T09:00:00.000Z',
  lastMessage: {
    direction: 'inbound',
    text: 'Olá',
    at: '2026-10-22T10:00:00.000Z',
    byMember: false,
  },
  unread: 1,
  ...over,
});

const msg = (over: Partial<InboxMessage>): InboxMessage => ({
  id: 'm1',
  direction: 'inbound',
  type: 'text',
  text: 'Olá',
  at: '2026-10-22T10:00:00.000Z',
  payload: { from: '351911111111', id: 'w1', timestamp: '1', type: 'text', text: { body: 'Olá' } },
  sentBy: null,
  ...over,
});

const detail = (conversation = row()): InboxConversationDetail => ({
  conversation,
  messages: [msg({})],
  leads: [],
  assignable: [{ id: ME, name: 'Sara', email: 'sara@example.invalid' }],
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  close(): void {
    this.closed = true;
  }
}

describe('InboxStore', () => {
  let requests: { method: string; url: string; body: unknown }[];
  let respond: (method: string, url: string, body: unknown) => Response;

  beforeEach(() => {
    requests = [];
    respond = () => json({ conversations: [row()], needsPerson: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        return respond(method, url, body);
      }),
    );
    vi.stubGlobal('EventSource', FakeEventSource);
    TestBed.configureTestingModule({ providers: [provideRouter([]), InboxStore] });
    TestBed.inject(AdminApi).clientId = 'jular';
    TestBed.inject(SessionStore).context.set({
      member: {
        id: ME,
        email: 'sara@example.invalid',
        name: 'Sara',
        role: 'sales',
        branches: ['maia'],
      },
      client: { id: 'jular', name: 'Jular', timezone: 'Europe/Lisbon' },
      role: 'sales',
      branches: [{ id: 'maia', name: 'Maia', region: 'Norte' }],
      allBranches: [{ id: 'maia', name: 'Maia', region: 'Norte' }],
    } as AdminContextView);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads a filtered list and keeps it current from the stream', async () => {
    const store = TestBed.inject(InboxStore);
    await store.load();
    expect(requests[0]).toMatchObject({ url: '/api/admin/clients/jular/inbox?view=human' });
    expect(store.conversations().map((c) => c.id)).toEqual(['c1']);

    store.connect();
    const source = FakeEventSource.last!;
    expect(source.url).toBe('/api/admin/clients/jular/inbox/stream');
    source.onopen?.();
    expect(store.live()).toBe(true);

    // A new handoff arrives on top; c1 goes back to the bot and leaves "needs a person".
    source.emit({
      type: 'conversation',
      conversation: row({ id: 'c2', lastActivityAt: '2026-10-22T11:00:00.000Z' }),
    });
    expect(store.conversations().map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(store.needsPerson()).toBe(2);
    source.emit({ type: 'conversation', conversation: row({ status: 'bot' }) });
    expect(store.conversations().map((c) => c.id)).toEqual(['c2']);
    expect(store.needsPerson()).toBe(1);

    // "Mine" only keeps rows assigned to me.
    respond = () => json({ conversations: [], needsPerson: 1 });
    await store.setView('mine');
    expect(requests.at(-1)!.url).toBe('/api/admin/clients/jular/inbox?view=mine');
    source.emit({ type: 'conversation', conversation: row({ id: 'c3' }) });
    expect(store.conversations()).toEqual([]);
    const mine = row({
      id: 'c3',
      assignedTo: { id: ME, name: 'Sara', email: 'sara@example.invalid' },
    });
    source.emit({ type: 'conversation', conversation: mine });
    expect(store.conversations().map((c) => c.id)).toEqual(['c3']);

    await store.setBranch('maia');
    expect(requests.at(-1)!.url).toBe('/api/admin/clients/jular/inbox?view=mine&branch=maia');

    store.disconnect();
    expect(source.closed).toBe(true);
  });

  it('opens a conversation, marks it read, takes over, replies and hands back', async () => {
    respond = (method, url, body) => {
      if (url.endsWith('/inbox?view=human'))
        return json({ conversations: [row()], needsPerson: 1 });
      if (url.endsWith('/read')) return new Response(null, { status: 204 });
      if (url.endsWith('/takeover')) {
        return json(row({ assignedTo: { id: ME, name: 'Sara', email: 'sara@example.invalid' } }));
      }
      if (url.endsWith('/bot')) return json(row({ status: 'bot', unread: 0 }));
      if (url.endsWith('/reply')) {
        const text = (body as { text: string }).text;
        return json(
          msg({
            id: 'm2',
            direction: 'outbound',
            text,
            payload: {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: '351911111111',
              type: 'text',
              text: { body: text },
            },
            sentBy: { id: ME, name: 'Sara', email: 'sara@example.invalid' },
          }),
          201,
        );
      }
      if (url.endsWith('/inbox/c1') && method === 'GET') return json(detail());
      return json({ error: 'not_found', message: 'Conversa não encontrada.' }, 404);
    };
    const store = TestBed.inject(InboxStore);
    await store.load();
    await store.open('c1');
    expect(store.detail()?.messages).toHaveLength(1);
    expect(store.conversations()[0]!.unread).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toContain(
      'POST /api/admin/clients/jular/inbox/c1/read',
    );

    await store.takeOver();
    expect(store.detail()?.conversation.assignedTo?.id).toBe(ME);

    expect(await store.reply('Bom dia, sou a Sara.')).toBe(true);
    expect(requests.find((r) => r.url.endsWith('/reply'))).toMatchObject({
      method: 'POST',
      body: { text: 'Bom dia, sou a Sara.' },
    });
    const last = store.detail()!.messages.at(-1)!;
    expect(toInboxMessageView(last)).toMatchObject({ side: 'out', author: 'Sara', byMember: true });

    await store.returnToBot();
    expect(store.detail()?.conversation.status).toBe('bot');
    expect(store.conversations()).toEqual([]); // no longer needs a person
    expect(store.needsPerson()).toBe(0);

    store.close();
    await store.open('missing');
    expect(store.detailError()).toBe('Conversa não encontrada.');
  });
});

describe('ConversationPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the transcript and sends a reply from the box', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/reply')) {
          sent.push(JSON.parse(String(init!.body)));
          return json(
            msg({ id: 'm9', direction: 'outbound', sentBy: { id: ME, name: 'Sara', email: 'x' } }),
            201,
          );
        }
        if (url.endsWith('/read')) return new Response(null, { status: 204 });
        return json(detail(row({ status: 'bot' })));
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([]), InboxStore] });
    TestBed.inject(AdminApi).clientId = 'jular';
    const fixture = TestBed.createComponent(ConversationPage);
    fixture.componentRef.setInput('id', 'c1');
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.thread__name')?.textContent).toContain('Ana');
    expect(el.textContent).toContain('Assumir conversa');
    expect(el.textContent).toContain('Ao responder, assume a conversa');

    const box = el.querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'Olá Ana';
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sent).toEqual([{ text: 'Olá Ana' }]);
    expect(box.value).toBe('');
    expect(el.querySelectorAll('.msg')).toHaveLength(2);
  });
});

describe('toInboxMessageView', () => {
  it('shows taps, product cards and the author', () => {
    const tap = msg({
      payload: {
        from: '1',
        id: 'w',
        timestamp: '1',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'product:42', title: 'Quero este' },
        },
      },
    });
    expect(toInboxMessageView(tap)).toMatchObject({ side: 'in', kind: 'tap', text: 'Quero este' });
    const card = msg({
      direction: 'outbound',
      payload: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '1',
        type: 'interactive',
        interactive: {
          type: 'button',
          header: { type: 'text', text: 'Deck pinho' },
          body: { text: '24 €/m²' },
          action: {
            buttons: [{ type: 'reply', reply: { id: 'product:42', title: 'Quero este' } }],
          },
        },
      },
    });
    expect(toInboxMessageView(card)).toMatchObject({
      author: 'Assistente',
      byMember: false,
      kind: 'buttons',
      header: 'Deck pinho',
      options: [{ id: 'product:42', title: 'Quero este' }],
    });
  });

  it('shows a document (a quote PDF) with its file name and link', () => {
    const doc = msg({
      direction: 'outbound',
      type: 'document',
      text: 'Orçamento ACME-2026-0001',
      payload: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '1',
        type: 'document',
        document: {
          link: 'https://x.test/static/quotes/tok/Orcamento-ACME-2026-0001.pdf',
          filename: 'Orcamento-ACME-2026-0001.pdf',
          caption: 'Orçamento ACME-2026-0001',
        },
      },
    });
    expect(toInboxMessageView(doc)).toMatchObject({
      kind: 'document',
      documentUrl: 'https://x.test/static/quotes/tok/Orcamento-ACME-2026-0001.pdf',
      fileName: 'Orcamento-ACME-2026-0001.pdf',
      fileType: 'PDF',
      text: 'Orçamento ACME-2026-0001',
    });
    const noName = msg({
      direction: 'outbound',
      type: 'document',
      payload: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '1',
        type: 'document',
        document: { link: 'https://x.test/static/quotes/tok/Or%C3%A7amento.pdf' },
      },
    });
    expect(toInboxMessageView(noName)).toMatchObject({ fileName: 'Orçamento.pdf', text: '' });
  });
});
