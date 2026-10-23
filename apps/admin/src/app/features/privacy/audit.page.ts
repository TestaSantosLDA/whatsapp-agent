import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { PrivacyAuditEntry } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { auditActionLabel, formatCounts, formatDate } from './privacy.format';

/**
 * Audit log (WA-028): who exported, cleared or deleted, and when. It holds no personal content:
 * the customer is a code (a hash of their record) that matches entries about the same person.
 */
@Component({
  selector: 'app-privacy-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  styles: `
    .log {
      list-style: none;
      margin: 12px 0 0;
      padding: 0;
    }
    .log li {
      padding: 10px 0;
      border-top: 1px solid var(--border);
      overflow-wrap: anywhere;
    }
    .log__head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    code {
      font-size: 12px;
    }
  `,
  template: `
    <section class="card">
      <h2 class="card__title">Registo de privacidade</h2>
      <p class="muted small">
        Sem dados pessoais: o cliente aparece como um código, igual em todas as entradas sobre a
        mesma pessoa.
      </p>
      <ul class="log">
        @for (e of entries(); track e.id) {
          <li>
            <div class="log__head">
              <strong>{{ actionLabel[e.action] }}</strong>
              <span class="muted small">{{ date(e.createdAt) }}</span>
            </div>
            <div class="small">
              {{ e.actor ?? 'Tarefa automática' }} · cliente
              <code>{{ e.targetHash.slice(0, 10) }}</code>
            </div>
            @if (e.action !== 'export' && e.action !== 'request_rejected') {
              <div class="muted small">{{ counts(e.counts) }}</div>
            }
          </li>
        } @empty {
          <li class="muted small">Ainda não há entradas.</li>
        }
      </ul>
    </section>
    @if (error()) {
      <p class="notice notice--error" role="alert">{{ error() }}</p>
    }
  `,
})
export class PrivacyAuditPage {
  private readonly api = inject(AdminApi);
  protected readonly entries = signal<PrivacyAuditEntry[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly actionLabel = auditActionLabel;
  protected readonly date = formatDate;
  protected readonly counts = formatCounts;

  constructor() {
    this.api
      .client<PrivacyAuditEntry[]>('GET', '/privacy/audit')
      .then((list) => this.entries.set(list))
      .catch((e) =>
        this.error.set(
          e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.',
        ),
      );
  }
}
