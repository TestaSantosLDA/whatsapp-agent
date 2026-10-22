import type { SimEvent } from '@wa/shared';

/**
 * In-memory pub/sub for simulator and back-office events, keyed by client and customer phone.
 * Fine for a single instance; several instances would need Postgres LISTEN/NOTIFY or Redis.
 */
export class EventBus<E = SimEvent> {
  private readonly listeners = new Map<string, Set<(event: E) => void>>();

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

  publish(key: string, event: E): void {
    for (const listener of this.listeners.get(key) ?? []) listener(event);
  }
}
