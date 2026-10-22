import { Injectable, signal } from '@angular/core';
import type { SimClientSummary, SimSendBody } from '@wa/shared';

export interface SimConfig {
  accessCodeRequired: boolean;
}

/** Thrown when the API answers 401: the access code is missing or wrong. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** Any other non-2xx answer. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CODE_KEY = 'wa-sim.accessCode';

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode etc.): the app still works for this session.
  }
}

/** Thin fetch wrapper around the simulator API (see WA-006). Paths are relative; the dev proxy forwards them. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly accessCode = signal<string | null>(storageGet(CODE_KEY));

  setAccessCode(code: string | null): void {
    this.accessCode.set(code);
    storageSet(CODE_KEY, code);
  }

  async config(): Promise<SimConfig> {
    const res = await fetch('/sim/config', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /sim/config failed: ${res.status}`);
    return (await res.json()) as SimConfig;
  }

  clients(): Promise<SimClientSummary[]> {
    return this.request<SimClientSummary[]>('GET', '/sim/clients');
  }

  send(clientId: string, body: SimSendBody): Promise<{ messageId: string }> {
    return this.request('POST', `/sim/${encodeURIComponent(clientId)}/messages`, body);
  }

  async reset(clientId: string, phone: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/sim/${encodeURIComponent(clientId)}/reset?phone=${encodeURIComponent(phone)}`,
    );
  }

  /** Hands the conversation back to the bot after a person took over (WA-016). */
  async returnToBot(clientId: string, phone: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/sim/${encodeURIComponent(clientId)}/conversation/bot?phone=${encodeURIComponent(phone)}`,
    );
  }

  streamUrl(clientId: string, phone: string): string {
    return this.sseUrl(clientId, 'stream', phone);
  }

  backofficeUrl(clientId: string, phone: string): string {
    return this.sseUrl(clientId, 'backoffice', phone);
  }

  /** EventSource cannot send headers, so the access code goes in the query string. */
  private sseUrl(clientId: string, path: string, phone: string): string {
    let url = `/sim/${encodeURIComponent(clientId)}/${path}?phone=${encodeURIComponent(phone)}`;
    const code = this.accessCode();
    if (code) url += `&code=${encodeURIComponent(code)}`;
    return url;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const code = this.accessCode();
    if (code) headers['X-Access-Code'] = code;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError(`${method} ${path} failed: ${res.status} ${detail}`.trim(), res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
