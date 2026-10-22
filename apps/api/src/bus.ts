import type { SimEvent } from '@wa/shared';

type Listener = (event: SimEvent) => void;

/**
 * In-memory pub/sub for simulator events, keyed by client and customer phone.
 * Fine for a single instance; several instances would need Postgres LISTEN/NOTIFY or Redis.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  static key(clientId: string, phone: string): string {
    return `${clientId}:${phone}`;
  }

  subscribe(key: string, listener: Listener): () => void {
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

  publish(key: string, event: SimEvent): void {
    for (const listener of this.listeners.get(key) ?? []) listener(event);
  }
}
