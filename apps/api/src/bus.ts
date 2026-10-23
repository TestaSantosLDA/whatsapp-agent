import type { SimEvent } from '@wa/shared';

/**
 * In-memory pub/sub for simulator and back-office events, keyed by client and customer phone.
 * Fine for a single instance; several instances would need Postgres LISTEN/NOTIFY or Redis.
 */
export class EventBus<E = SimEvent> {
  private readonly listeners = new Map<string, Set<(event: E) => void>>();
  private readonly everything = new Set<(key: string, event: E) => void>();

  static key(clientId: string, phone: string): string {
    return `${clientId}:${phone}`;
  }

  subscribe(key: string, listener: (event: E) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Every event of every key, e.g. for the dashboard inbox (WA-023). */
  subscribeAll(listener: (key: string, event: E) => void): () => void {
    this.everything.add(listener);
    return () => this.everything.delete(listener);
  }

  /** The client id and phone of a key built with `key()`. */
  static parseKey(key: string): { clientId: string; phone: string } {
    const at = key.lastIndexOf(':');
    return { clientId: key.slice(0, at), phone: key.slice(at + 1) };
  }

  publish(key: string, event: E): void {
    for (const listener of this.listeners.get(key) ?? []) listener(event);
    for (const listener of this.everything) listener(key, event);
  }
}
