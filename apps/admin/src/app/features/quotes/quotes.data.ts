import { inject, Injectable } from '@angular/core';
import type { QuoteDetail, QuoteDraft, QuoteListItem, SendQuoteBody } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

const path = (id: string) => `/quotes/${encodeURIComponent(id)}`;

/** Calls the quotes API (WA-025). */
@Injectable({ providedIn: 'root' })
export class QuotesData {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthService);

  forLead(leadId: string): Promise<QuoteListItem[]> {
    return this.api.client('GET', `/quotes?lead=${encodeURIComponent(leadId)}`);
  }

  create(leadId: string): Promise<QuoteDetail> {
    return this.api.client('POST', '/quotes', { leadId });
  }

  get(id: string): Promise<QuoteDetail> {
    return this.api.client('GET', path(id));
  }

  save(id: string, draft: QuoteDraft): Promise<QuoteDetail> {
    return this.api.client('PUT', path(id), draft);
  }

  remove(id: string): Promise<void> {
    return this.api.client('DELETE', path(id));
  }

  send(id: string, body: SendQuoteBody): Promise<QuoteDetail> {
    return this.api.client('POST', `${path(id)}/send`, body);
  }

  /** The PDF as a blob URL (the API needs the token, so a plain link would not do). */
  async pdfUrl(id: string): Promise<string> {
    const url = `/api/admin/clients/${encodeURIComponent(this.api.clientId ?? '')}${path(id)}/pdf`;
    const token = this.auth.token();
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        detail.error ?? 'http_error',
        detail.message ?? 'Não foi possível abrir o PDF.',
      );
    }
    return URL.createObjectURL(await res.blob());
  }
}

/** A number as typed in pt-PT ("58,439", "1 234,5") or NaN. */
export function parseDecimal(text: string): number {
  const clean = text.replace(/\s/g, '').replace(',', '.');
  return clean === '' ? NaN : Number(clean);
}

/** A number for an input: comma decimals, no thousands separator. */
export const decimalText = (n: number) => (Number.isFinite(n) ? String(n).replace('.', ',') : '');

const dateFormat = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** "23/10/2026" */
export const longDate = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? iso.split('-').reverse().join('/')
    : dateFormat.format(new Date(iso));
