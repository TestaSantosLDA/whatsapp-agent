import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import type { SimChatMessage, SimClientSummary, SimEvent, SimSendBody } from '@wa/shared';
import { ApiService, storageGet, storageSet, UnauthorizedError } from './api.service';
import { Persona, PERSONAS } from './personas';

/** Minimal EventSource surface, so tests can swap in a fake. */
export interface EventSourceLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSourceLike>(
  'EVENT_SOURCE_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new EventSource(url) },
);

export type Phase = 'loading' | 'gate' | 'ready' | 'error';
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying';
export type InteractiveReply = Extract<SimSendBody, { reply: unknown }>['reply'];

const CLIENT_KEY = 'wa-sim.clientId';
const PERSONA_KEY = 'wa-sim.persona';
const EVENTSOURCE_CLOSED = 2;
const RETRY_MS = 3000;

function loadPersona(): Persona {
  try {
    const raw = storageGet(PERSONA_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persona;
      if (p && typeof p.name === 'string' && /^\d+$/.test(p.phone)) return p;
    }
  } catch {
    // ignore malformed value
  }
  return PERSONAS[0];
}

/** Holds the simulator state as signals and owns the SSE connection for the current client + persona. */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly api = inject(ApiService);
  private readonly createEventSource = inject(EVENT_SOURCE_FACTORY);

  readonly phase = signal<Phase>('loading');
  readonly gateError = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly clients = signal<SimClientSummary[]>([]);
  readonly clientId = signal<string | null>(null);
  readonly persona = signal<Persona>(loadPersona());
  readonly messages = signal<SimChatMessage[]>([]);
  readonly typing = signal(false);
  readonly connection = signal<Connection>('idle');
  readonly conversationStatus = signal<string | null>(null);
  readonly sending = signal(false);
  /** Bumped whenever the chat starts over (client or persona switch, reset), so the back-office panel can follow. */
  readonly session = signal(0);

  readonly client = computed(() => this.clients().find((c) => c.id === this.clientId()) ?? null);

  private es: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 'read' statuses that arrived before their message. */
  private readonly pendingRead = new Set<string>();

  async init(): Promise<void> {
    this.phase.set('loading');
    try {
      const cfg = await this.api.config();
      if (cfg.accessCodeRequired && !this.api.accessCode()) {
        this.phase.set('gate');
        return;
      }
      await this.loadClients();
    } catch (e) {
      this.fail(e);
    }
  }

  async submitAccessCode(code: string): Promise<void> {
    this.api.setAccessCode(code.trim() || null);
    this.gateError.set(null);
    try {
      await this.loadClients();
    } catch (e) {
      this.fail(e);
    }
  }

  selectClient(id: string): void {
    if (id === this.clientId()) return;
    this.clientId.set(id);
    storageSet(CLIENT_KEY, id);
    this.reconnect();
  }

  selectPersona(p: Persona): void {
    const cur = this.persona();
    if (cur.phone === p.phone && cur.name === p.name && cur.id === p.id) return;
    this.persona.set(p);
    storageSet(PERSONA_KEY, JSON.stringify(p));
    this.reconnect();
  }

  async sendText(text: string): Promise<boolean> {
    const body = text.trim();
    if (!body) return false;
    const p = this.persona();
    return this.send({ phone: p.phone, name: p.name, text: body });
  }

  sendReply(reply: InteractiveReply): Promise<boolean> {
    const p = this.persona();
    return this.send({ phone: p.phone, name: p.name, reply });
  }

  async reset(): Promise<void> {
    const id = this.clientId();
    if (!id) return;
    this.disconnect();
    this.clearChat();
    try {
      await this.api.reset(id, this.persona().phone);
    } catch (e) {
      this.fail(e);
      if (this.phase() !== 'ready') return;
    }
    this.session.update((n) => n + 1);
    this.connect();
  }

  /** Applies one SSE event to the state. Public for tests. */
  handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'history':
        this.messages.set(this.dedupe(ev.messages.map((m) => this.applyPendingRead(m))));
        this.conversationStatus.set(ev.conversationStatus);
        this.typing.set(false);
        break;
      case 'message': {
        const msg = this.applyPendingRead(ev.message);
        this.messages.update((list) => {
          const i = list.findIndex((m) => m.id === msg.id);
          if (i === -1) return [...list, msg];
          const copy = list.slice();
          copy[i] = msg;
          return copy;
        });
        if (msg.direction === 'outbound') this.typing.set(false);
        break;
      }
      case 'status': {
        let found = false;
        this.messages.update((list) =>
          list.map((m) => {
            if (m.id !== ev.messageId || m.direction !== 'inbound') return m;
            found = true;
            return { ...m, status: ev.status };
          }),
        );
        if (!found) this.pendingRead.add(ev.messageId);
        break;
      }
      case 'typing':
        this.typing.set(ev.on);
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

  private async loadClients(): Promise<void> {
    const clients = await this.api.clients();
    this.clients.set(clients);
    this.phase.set('ready');
    this.error.set(clients.length ? null : 'No clients configured on the server.');
    const saved = storageGet(CLIENT_KEY);
    const pick =
      clients.find((c) => c.id === this.clientId()) ??
      clients.find((c) => c.id === saved) ??
      clients[0];
    if (pick) {
      this.clientId.set(pick.id);
      this.reconnect();
    }
  }

  private async send(body: SimSendBody): Promise<boolean> {
    const id = this.clientId();
    if (!id) return false;
    this.sending.set(true);
    try {
      await this.api.send(id, body);
      this.error.set(null);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.sending.set(false);
    }
  }

  private reconnect(): void {
    this.disconnect();
    this.clearChat();
    this.session.update((n) => n + 1);
    this.connect();
  }

  private clearChat(): void {
    this.messages.set([]);
    this.typing.set(false);
    this.conversationStatus.set(null);
    this.pendingRead.clear();
  }

  private connect(): void {
    const id = this.clientId();
    if (!id || this.phase() !== 'ready') return;
    this.connection.set('connecting');
    const es = this.createEventSource(this.api.streamUrl(id, this.persona().phone));
    this.es = es;
    es.onopen = () => {
      this.connection.set('open');
      this.error.set(null);
    };
    es.onmessage = (msg) => {
      try {
        this.handleEvent(JSON.parse(msg.data) as SimEvent);
      } catch (err) {
        console.warn('Ignoring malformed SSE event', msg.data, err);
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // CONNECTING: the browser retries by itself. CLOSED: the server refused (e.g. 401); find out why.
      this.connection.set('retrying');
      if (es.readyState === EVENTSOURCE_CLOSED) {
        this.disconnect();
        this.connection.set('retrying');
        void this.probeAndRetry();
      }
    };
  }

  private async probeAndRetry(): Promise<void> {
    try {
      await this.api.clients();
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.fail(e);
        return;
      }
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_MS);
  }

  private applyPendingRead(m: SimChatMessage): SimChatMessage {
    if (m.direction === 'inbound' && this.pendingRead.delete(m.id)) return { ...m, status: 'read' };
    return m;
  }

  private dedupe(list: SimChatMessage[]): SimChatMessage[] {
    const seen = new Map<string, number>();
    const out: SimChatMessage[] = [];
    for (const m of list) {
      const i = seen.get(m.id);
      if (i === undefined) {
        seen.set(m.id, out.length);
        out.push(m);
      } else out[i] = m;
    }
    return out;
  }

  private fail(e: unknown): void {
    if (e instanceof UnauthorizedError) {
      this.disconnect();
      this.api.setAccessCode(null);
      this.gateError.set('Access code missing or wrong.');
      this.phase.set('gate');
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (this.phase() === 'loading') this.phase.set('error');
    this.error.set(message);
  }
}
