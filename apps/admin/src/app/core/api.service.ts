import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';

/** A non-2xx answer from the admin API: `{ error: code, message }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Calls the admin API with the signed-in member's token (WA-022). Feature stores use
 * `client()` for routes below /api/admin/clients/:clientId, e.g. `api.client('GET', '/leads')`.
 * A 401 signs out and returns to the login screen.
 */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  /** Set by SessionStore when the member's client is known. */
  clientId: string | null = null;

  /** `path` below /api/admin, e.g. `/me`. */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, `/api/admin${path}`, body);
  }

  /** `path` below /api/admin/clients/<current client>, e.g. `/settings`. */
  client<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.clientId) return Promise.reject(new ApiError(0, 'no_client', 'Sem cliente.'));
    return this.request<T>(method, `/clients/${encodeURIComponent(this.clientId)}${path}`, body);
  }

  /** URL for an EventSource stream (no headers there, so the token goes in the query). */
  streamUrl(path: string): string {
    const url = `/api/admin/clients/${encodeURIComponent(this.clientId ?? '')}${path}`;
    const token = this.auth.token();
    return token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${token}` : url;
  }

  private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.auth.token();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // FormData (file uploads) sets its own multipart content type with the boundary.
    const form = body instanceof FormData;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    if (res.status === 401) {
      await this.auth.signOut();
      void this.router.navigateByUrl('/login').catch(() => false);
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        detail.error ?? 'http_error',
        detail.message ?? `${method} ${url} falhou (${res.status}).`,
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
