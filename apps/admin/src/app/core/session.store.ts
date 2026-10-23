import { computed, inject, Injectable, signal } from '@angular/core';
import type { AdminContextView, AdminMe, AdminMembership } from '@wa/shared';
import { AdminApi } from './api.service';
import { AuthService } from './auth.service';
import { storageGet, storageSet } from './storage';

const CLIENT_KEY = 'wa-admin.clientId';

/**
 * Who is signed in, which client team they are working in, and how the API scopes them
 * (role and branches). Feature screens read `context()`, `isAdmin()` and `branches()`.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthService);
  private loadedFor: string | null = null;

  readonly me = signal<AdminMe | null>(null);
  readonly context = signal<AdminContextView | null>(null);
  readonly memberships = computed<AdminMembership[]>(() => this.me()?.memberships ?? []);
  readonly isAdmin = computed(() => this.context()?.role === 'admin');
  readonly branches = computed(() => this.context()?.branches ?? []);
  readonly clientName = computed(() => this.context()?.client.name ?? '');

  private loading: Promise<boolean> | null = null;

  /** Loads the member's teams and the chosen client's context. False: not on any team. */
  load(): Promise<boolean> {
    this.loading ??= this.fetch().finally(() => (this.loading = null));
    return this.loading;
  }

  /** Loaded for the user signed in now (not for someone who signed out on this device). */
  get loaded(): boolean {
    return this.context() !== null && this.loadedFor === this.auth.userId();
  }

  async switchClient(clientId: string): Promise<void> {
    storageSet(CLIENT_KEY, clientId);
    this.context.set(null);
    await this.load();
  }

  reset(): void {
    this.me.set(null);
    this.context.set(null);
    this.api.clientId = null;
  }

  private async fetch(): Promise<boolean> {
    this.loadedFor = this.auth.userId();
    const me = await this.api.request<AdminMe>('GET', '/me');
    this.me.set(me);
    const saved = storageGet(CLIENT_KEY);
    const membership =
      me.memberships.find((m) => m.clientId === saved) ?? me.memberships[0] ?? null;
    if (!membership) {
      this.context.set(null);
      return false;
    }
    this.api.clientId = membership.clientId;
    this.context.set(await this.api.client<AdminContextView>('GET', '/context'));
    return true;
  }
}
