import { inject, Injectable, signal } from '@angular/core';
import type {
  AdminLeadDetail,
  AdminLeadList,
  AdminLeadNote,
  LeadStatus,
  LostReason,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

/** The list's filters, kept while the app is open so "back" from a lead finds them again. */
export interface LeadFilters {
  q: string;
  status: LeadStatus[];
  /** '' (all), `info,quote,sample`, `order` or `handoff`. */
  type: string;
  branch: string;
  /** '' (everyone), `me`, `none` or a member id. */
  owner: string;
}

export const emptyFilters = (): LeadFilters => ({
  q: '',
  status: [],
  type: '',
  branch: '',
  owner: '',
});

/** Query string for GET /leads and /leads/export.csv. */
export function leadsQuery(f: LeadFilters, page?: { limit: number; offset: number }): string {
  const params = new URLSearchParams();
  if (f.q.trim()) params.set('q', f.q.trim());
  if (f.status.length) params.set('status', f.status.join(','));
  if (f.type) params.set('type', f.type);
  if (f.branch) params.set('branch', f.branch);
  if (f.owner) params.set('owner', f.owner);
  if (page) {
    params.set('limit', String(page.limit));
    params.set('offset', String(page.offset));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The one-tap next steps shown on a lead in the list. Closed leads reopen from their page. */
export function nextStatuses(status: LeadStatus): LeadStatus[] {
  switch (status) {
    case 'new':
      return ['contacted', 'quoted', 'lost'];
    case 'contacted':
      return ['quoted', 'won', 'lost'];
    case 'quoted':
      return ['won', 'lost'];
    default:
      return [];
  }
}

export interface StatusChange {
  status: LeadStatus;
  lostReason?: LostReason;
}

/** Calls the leads API (WA-024) for the list and the lead page. */
@Injectable({ providedIn: 'root' })
export class LeadsData {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthService);

  readonly filters = signal<LeadFilters>(emptyFilters());

  list(f: LeadFilters, page: { limit: number; offset: number }): Promise<AdminLeadList> {
    return this.api.client('GET', `/leads${leadsQuery(f, page)}`);
  }

  detail(id: string): Promise<AdminLeadDetail> {
    return this.api.client('GET', `/leads/${encodeURIComponent(id)}`);
  }

  setStatus(id: string, change: StatusChange & { note?: string }): Promise<AdminLeadDetail> {
    return this.api.client('PATCH', `/leads/${encodeURIComponent(id)}/status`, change);
  }

  setOwner(id: string, ownerId: string | null): Promise<AdminLeadDetail> {
    return this.api.client('PATCH', `/leads/${encodeURIComponent(id)}/owner`, { ownerId });
  }

  addNote(id: string, body: string): Promise<AdminLeadNote> {
    return this.api.client('POST', `/leads/${encodeURIComponent(id)}/notes`, { body });
  }

  /** Downloads the filtered leads as CSV (a file the browser saves). */
  async exportCsv(f: LeadFilters): Promise<void> {
    const url = `/api/admin/clients/${encodeURIComponent(this.api.clientId ?? '')}/leads/export.csv${leadsQuery(f)}`;
    const token = this.auth.token();
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        detail.error ?? 'http_error',
        detail.message ?? 'Não foi possível exportar.',
      );
    }
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'pedidos.csv';
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

/** "há 3,5 h úteis" */
export function waitingLabel(hours: number): string {
  const shown = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
  return `${String(shown).replace('.', ',')} h úteis`;
}

const dateFormat = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "23/10, 14:05" in the browser's time zone (the team's). */
export const shortDate = (iso: string) => dateFormat.format(new Date(iso));

export const personName = (p: { name: string | null; email: string } | null) =>
  p ? p.name || p.email : 'Sem responsável';

export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.';

/** "Lisboa (Camarate)" for "Lisboa (Camarate) — loja e ponto de recolha…": short enough for a row. */
export function shortBranch(name: string | null): string {
  if (!name) return 'Sem filial';
  const head = name.split(' — ')[0]!.trim();
  return head.replace(/\s*\(([^)]{20,})\)$/, '');
}
