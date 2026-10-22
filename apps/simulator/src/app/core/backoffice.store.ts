import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import type {
  BackofficeEmail,
  BackofficeEvent,
  BackofficeLead,
  BackofficeTurn,
  ConversationStatus,
} from '@wa/shared';
import { ApiError, ApiService, storageGet, storageSet } from './api.service';
import {
  ChatStore,
  EVENT_SOURCE_FACTORY,
  type Connection,
  type EventSourceLike,
} from './chat.store';

const TRACE_KEY = 'wa-sim.showTrace';
const EVENTSOURCE_CLOSED = 2;
const RETRY_MS = 3000;

/**
 * State of the back-office panel (WA-018): leads, emails, agent turns and the conversation status
 * for the current client and persona, fed by GET /sim/:clientId/backoffice (SSE). Follows the
 * chat: it starts over when the client, the persona or the conversation changes.
 */
@Injectable({ providedIn: 'root' })
export class BackofficeStore {
  private readonly api = inject(ApiService);
  private readonly chat = inject(ChatStore);
  private readonly createEventSource = inject(EVENT_SOURCE_FACTORY);

  readonly leads = signal<BackofficeLead[]>([]);
  readonly emails = signal<BackofficeEmail[]>([]);
  readonly turns = signal<BackofficeTurn[]>([]);
  readonly status = signal<ConversationStatus | null>(null);
  readonly connection = signal<Connection>('idle');
  readonly returning = signal(false);
  readonly notice = signal<string | null>(null);
  /** Off by default: client-facing demos show the business side, not the agent's internals. */
  readonly showTrace = signal(storageGet(TRACE_KEY) === '1');

  private es: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const clientId = this.chat.clientId();
      const phone = this.chat.persona().phone;
      const ready = this.chat.phase() === 'ready';
      this.chat.session();
      untracked(() => {
        this.disconnect();
        this.clear();
        if (clientId && ready) this.connect(clientId, phone);
      });
    });
  }

  setShowTrace(on: boolean): void {
    this.showTrace.set(on);
    storageSet(TRACE_KEY, on ? '1' : null);
  }

  async returnToBot(): Promise<void> {
    const clientId = this.chat.clientId();
    if (!clientId) return;
    this.returning.set(true);
    this.notice.set(null);
    try {
      await this.api.returnToBot(clientId, this.chat.persona().phone);
      // The server also pushes a `conversation` event; don't wait for it to update the badge.
      this.status.set('bot');
    } catch (e) {
      this.notice.set(
        e instanceof ApiError && e.status === 404
          ? 'Este servidor ainda não permite devolver a conversa ao bot.'
          : 'Não foi possível devolver a conversa ao bot.',
      );
    } finally {
      this.returning.set(false);
    }
  }

  /** Applies one SSE event to the state. Public for tests. */
  handleEvent(ev: BackofficeEvent): void {
    switch (ev.type) {
      case 'snapshot':
        this.leads.set(dedupe(ev.leads));
        this.emails.set(dedupe(ev.emails));
        this.turns.set(dedupe(ev.turns));
        this.status.set(ev.conversationStatus);
        break;
      case 'lead':
        this.leads.update((list) => upsert(list, ev.lead));
        break;
      case 'email':
        this.emails.update((list) => upsert(list, ev.email));
        break;
      case 'turn':
        this.turns.update((list) => upsert(list, ev.turn));
        break;
      case 'conversation':
        this.status.set(ev.status);
        if (ev.status === 'bot') this.notice.set(null);
        break;
    }
  }

  disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.es) {
      this.es.onmessage = this.es.onerror = this.es.onopen = null;
      this.es.close();
      this.es = null;
    }
    this.connection.set('idle');
  }

  private clear(): void {
    this.leads.set([]);
    this.emails.set([]);
    this.turns.set([]);
    this.status.set(null);
    this.notice.set(null);
  }

  private connect(clientId: string, phone: string): void {
    this.connection.set('connecting');
    const es = this.createEventSource(this.api.backofficeUrl(clientId, phone));
    this.es = es;
    es.onopen = () => this.connection.set('open');
    es.onmessage = (msg) => {
      try {
        this.handleEvent(JSON.parse(msg.data) as BackofficeEvent);
      } catch (err) {
        console.warn('Ignoring malformed back-office event', msg.data, err);
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // CONNECTING: the browser retries by itself. CLOSED: the server refused; try again later
      // (the chat store deals with a wrong access code).
      this.connection.set('retrying');
      if (es.readyState === EVENTSOURCE_CLOSED) {
        this.disconnect();
        this.connection.set('retrying');
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect(clientId, phone);
        }, RETRY_MS);
      }
    };
  }
}

/** Keeps the first position of each id and the latest version of it. */
function dedupe<T extends { id: string }>(list: T[]): T[] {
  return list.reduce<T[]>((out, item) => upsert(out, item), []);
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}
