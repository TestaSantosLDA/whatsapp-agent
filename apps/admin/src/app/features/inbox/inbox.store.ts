import { computed, inject, Injectable, signal, type OnDestroy } from '@angular/core';
import type {
  InboxConversation,
  InboxConversationDetail,
  InboxEvent,
  InboxList,
  InboxMessage,
  InboxView,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';

/** Reconnect delay after the stream drops (the token may have been refreshed meanwhile). */
const RECONNECT_MS = 3000;

/**
 * The inbox (WA-023): the list with its filters, the open conversation, and the live stream that
 * keeps both current. Provided by the inbox routes, so the list and the conversation share it.
 */
@Injectable()
export class InboxStore implements OnDestroy {
  private readonly api = inject(AdminApi);
  private readonly session = inject(SessionStore);

  readonly view = signal<InboxView>('human');
  /** Branch filter; '' = every branch the member can see. */
  readonly branch = signal('');
  readonly conversations = signal<InboxConversation[]>([]);
  readonly needsPerson = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The stream is connected (live updates). */
  readonly live = signal(false);

  readonly openId = signal<string | null>(null);
  readonly detail = signal<InboxConversationDetail | null>(null);
  readonly detailError = signal<string | null>(null);
  readonly busy = signal(false);

  readonly memberId = computed(() => this.session.context()?.member.id ?? null);
  readonly unreadTotal = computed(() =>
    this.conversations().reduce((sum, c) => sum + (c.unread > 0 ? 1 : 0), 0),
  );

  private source: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private listRequest = 0;
  private detailRequest = 0;

  // ---------- List ----------

  async load(): Promise<void> {
    const request = ++this.listRequest;
    this.loading.set(true);
    this.error.set(null);
    const query = new URLSearchParams({ view: this.view() });
    if (this.branch()) query.set('branch', this.branch());
    try {
      const list = await this.api.client<InboxList>('GET', `/inbox?${query}`);
      if (request !== this.listRequest) return;
      this.conversations.set(list.conversations.map((c) => this.withOpenRead(c)));
      this.needsPerson.set(list.needsPerson);
    } catch (e) {
      if (request === this.listRequest) this.error.set(messageOf(e));
    } finally {
      if (request === this.listRequest) this.loading.set(false);
    }
  }

  setView(view: InboxView): Promise<void> {
    this.view.set(view);
    return this.load();
  }

  setBranch(branch: string): Promise<void> {
    this.branch.set(branch);
    return this.load();
  }

  // ---------- Live updates ----------

  /** Opens the stream (idempotent). The list reloads on every (re)connect. */
  connect(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    const source = new EventSource(this.api.streamUrl('/inbox/stream'));
    this.source = source;
    source.onopen = () => {
      this.live.set(true);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        this.apply(JSON.parse(message.data) as InboxEvent);
      } catch {
        // a malformed event: skip it
      }
    };
    source.onerror = () => {
      // Reconnect ourselves with a fresh URL: the token in the old one may have expired.
      this.live.set(false);
      source.close();
      if (this.source === source) this.source = null;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => {
        this.connect();
        void this.load();
      }, RECONNECT_MS);
    };
  }

  disconnect(): void {
    clearTimeout(this.retry);
    this.source?.close();
    this.source = null;
    this.live.set(false);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  /** A conversation changed: update or drop its row, and refresh it if it is open. */
  apply(event: InboxEvent): void {
    if (event.type !== 'conversation') return;
    const row = this.withOpenRead(event.conversation);
    const previous = this.conversations().find((c) => c.id === row.id);
    this.conversations.update((list) => {
      const rest = list.filter((c) => c.id !== row.id);
      return this.matches(row) ? sortRows([...rest, row]) : rest;
    });
    const wasHuman = previous?.status === 'human';
    if (previous ? wasHuman !== (row.status === 'human') : row.status === 'human') {
      this.needsPerson.update((n) => Math.max(0, n + (row.status === 'human' ? 1 : -1)));
    }
    if (row.id === this.openId()) {
      this.detail.update((d) => (d ? { ...d, conversation: row } : d));
      void this.refreshDetail(row.id, event.conversation.unread > 0);
    }
  }

  /** Whether a row belongs in the list under the current filters. */
  matches(row: InboxConversation): boolean {
    const view = this.view();
    if (view === 'human' && row.status !== 'human') return false;
    if (view === 'mine' && (row.assignedTo?.id !== this.memberId() || row.status === 'closed')) {
      return false;
    }
    return !this.branch() || row.branchId === this.branch();
  }

  // ---------- Conversation ----------

  async open(id: string): Promise<void> {
    this.openId.set(id);
    this.detail.set(null);
    this.detailError.set(null);
    await this.refreshDetail(id, true);
  }

  close(): void {
    this.openId.set(null);
    this.detail.set(null);
    this.detailError.set(null);
  }

  takeOver(): Promise<void> {
    return this.act((id) => this.api.client<InboxConversation>('POST', `/inbox/${id}/takeover`));
  }

  returnToBot(): Promise<void> {
    return this.act((id) => this.api.client<InboxConversation>('POST', `/inbox/${id}/bot`));
  }

  assign(memberId: string | null): Promise<void> {
    return this.act((id) =>
      this.api.client<InboxConversation>('POST', `/inbox/${id}/assign`, { memberId }),
    );
  }

  /** Sends a WhatsApp message as the member. True when it was sent. */
  async reply(text: string): Promise<boolean> {
    const id = this.openId();
    if (!id || !text.trim()) return false;
    this.busy.set(true);
    this.detailError.set(null);
    try {
      const sent = await this.api.client<InboxMessage>('POST', `/inbox/${id}/reply`, { text });
      this.detail.update((d) =>
        d && d.conversation.id === id && !d.messages.some((m) => m.id === sent.id)
          ? { ...d, messages: [...d.messages, sent] }
          : d,
      );
      return true;
    } catch (e) {
      this.detailError.set(messageOf(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async act(call: (id: string) => Promise<InboxConversation>): Promise<void> {
    const id = this.openId();
    if (!id) return;
    this.busy.set(true);
    this.detailError.set(null);
    try {
      const row = await call(id);
      this.apply({ type: 'conversation', conversation: row });
    } catch (e) {
      this.detailError.set(messageOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async refreshDetail(id: string, markRead: boolean): Promise<void> {
    const request = ++this.detailRequest;
    try {
      const detail = await this.api.client<InboxConversationDetail>('GET', `/inbox/${id}`);
      if (request !== this.detailRequest || this.openId() !== id) return;
      this.detail.set({ ...detail, conversation: { ...detail.conversation, unread: 0 } });
      if (markRead) {
        this.conversations.update((list) =>
          list.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
        );
        await this.api.client('POST', `/inbox/${id}/read`).catch(() => undefined);
      }
    } catch (e) {
      if (request === this.detailRequest && this.openId() === id) {
        this.detailError.set(messageOf(e));
      }
    }
  }

  /** The open conversation counts as read. */
  private withOpenRead(row: InboxConversation): InboxConversation {
    return row.id === this.openId() ? { ...row, unread: 0 } : row;
  }
}

function sortRows(rows: InboxConversation[]): InboxConversation[] {
  return rows.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.';
}
