import { inject, Injectable } from '@angular/core';
import {
  profileValueLabels,
  type CustomerDetail,
  type CustomerList,
  type CustomerRole,
  type ProfileField,
  type ProfileUsualProduct,
  type UpdateCustomerBody,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';

const enc = encodeURIComponent;

/** Calls the customers API (WA-027) for the list and the record page. */
@Injectable({ providedIn: 'root' })
export class CustomersData {
  private readonly api = inject(AdminApi);

  list(q: string, role: CustomerRole | '', offset = 0): Promise<CustomerList> {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (role) params.set('role', role);
    params.set('limit', '50');
    params.set('offset', String(offset));
    return this.api.client('GET', `/customers?${params}`);
  }

  detail(id: string): Promise<CustomerDetail> {
    return this.api.client('GET', `/customers/${enc(id)}`);
  }

  /** The record of a WhatsApp contact, for the inbox (WA-023). */
  byContact(contactId: string): Promise<CustomerDetail> {
    return this.api.client('GET', `/customers/by-contact/${enc(contactId)}`);
  }

  update(id: string, body: UpdateCustomerBody): Promise<CustomerDetail> {
    return this.api.client('PATCH', `/customers/${enc(id)}`, body);
  }

  addNote(id: string, body: string): Promise<CustomerDetail> {
    return this.api.client('POST', `/customers/${enc(id)}/notes`, { body });
  }

  linkPhone(id: string, phone: string): Promise<CustomerDetail> {
    return this.api.client('POST', `/customers/${enc(id)}/contacts`, { phone });
  }

  unlink(id: string, contactId: string): Promise<CustomerDetail> {
    return this.api.client('DELETE', `/customers/${enc(id)}/contacts/${enc(contactId)}`);
  }

  setField(
    id: string,
    field: ProfileField,
    body: { value?: unknown; locked?: boolean },
  ): Promise<CustomerDetail> {
    return this.api.client('PUT', `/customers/${enc(id)}/profile/${field}`, body);
  }

  removeField(id: string, field: ProfileField): Promise<CustomerDetail> {
    return this.api.client('DELETE', `/customers/${enc(id)}/profile/${field}`);
  }

  clearProfile(id: string): Promise<CustomerDetail> {
    return this.api.client('POST', `/customers/${enc(id)}/profile/clear`);
  }
}

export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.';

const dateFormat = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "23/10/26, 14:05" in the team's time zone. */
export const shortDate = (iso: string) => dateFormat.format(new Date(iso));

/** "+351 912 000 111" for "351912000111". */
export function formatPhone(digits: string): string {
  if (digits.startsWith('351') && digits.length === 12) {
    return `+351 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

/** How a profile value reads in the dashboard. */
export function profileText(field: ProfileField, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (field === 'usual_products' && Array.isArray(value)) {
    return (value as ProfileUsualProduct[])
      .map((p) => (p.quantity ? `${p.name} (${p.quantity})` : p.name))
      .join(' · ');
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (field === 'language')
    return value === 'en' ? 'Inglês' : value === 'pt-PT' ? 'Português' : String(value);
  return profileValueLabels[String(value)] ?? String(value);
}

/** The editor each field gets: a choice, yes/no, a list, or the products. */
export type FieldEditor =
  | { kind: 'choice'; options: { value: string; label: string }[] }
  | { kind: 'boolean' }
  | { kind: 'list' }
  | { kind: 'products' };

const choice = (...values: string[]): FieldEditor => ({
  kind: 'choice',
  options: values.map((v) => ({ value: v, label: profileValueLabels[v] ?? v })),
});

export const fieldEditors: Record<ProfileField, FieldEditor> = {
  detail_level: choice('short', 'full'),
  technical_depth: choice('basic', 'technical'),
  language: {
    kind: 'choice',
    options: [
      { value: 'pt-PT', label: 'Português' },
      { value: 'en', label: 'Inglês' },
    ],
  },
  usual_products: { kind: 'products' },
  job_types: { kind: 'list' },
  delivery: choice('site', 'pickup'),
  negotiates_on_volume: { kind: 'boolean' },
  price_tier: choice('retail', 'professional', 'reseller'),
};

/** The text an editor starts with for the current value. */
export function editorText(field: ProfileField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field === 'usual_products' && Array.isArray(value)) {
    return (value as ProfileUsualProduct[])
      .map((p) => (p.quantity ? `${p.name}; ${p.quantity}` : p.name))
      .join('\n');
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * The value to send for what the team typed. Products are one per line, "name; quantity"; a
 * product that keeps its name keeps its variant id.
 */
export function parseEditor(field: ProfileField, text: string, before: unknown): unknown {
  const editor = fieldEditors[field];
  switch (editor.kind) {
    case 'boolean':
      return text === 'true';
    case 'choice':
      return text;
    case 'list':
      return text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'products': {
      const earlier = Array.isArray(before) ? (before as ProfileUsualProduct[]) : [];
      return text
        .split('\n')
        .map((line) => line.split(';').map((s) => s.trim()))
        .filter(([name]) => name)
        .map(([name, quantity]) => {
          const same = earlier.find((p) => p.name.toLowerCase() === name!.toLowerCase());
          return {
            name: name!,
            ...(same?.variant_id ? { variant_id: same.variant_id } : {}),
            ...(quantity ? { quantity } : {}),
          };
        });
    }
  }
}
