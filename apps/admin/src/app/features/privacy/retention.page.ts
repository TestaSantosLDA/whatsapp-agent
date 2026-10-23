import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { PrivacyRetentionView } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { formatDate, formatPhone } from './privacy.format';

/**
 * Retention (WA-028): customers with no activity for the client's retention period are deleted by
 * a daily job; this lists those due within the next week, so the team can act first.
 */
@Component({
  selector: 'app-privacy-retention',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  styles: `
    .due {
      list-style: none;
      margin: 12px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .due li {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 0;
      border-top: 1px solid var(--border);
    }
    .due__who {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .due__when {
      text-align: right;
      white-space: nowrap;
    }
  `,
  template: `
    @if (view(); as v) {
      <section class="card">
        <h2 class="card__title">Apagados nos próximos {{ v.days }} dias</h2>
        <p class="muted small">
          Os clientes sem atividade há mais de {{ v.months }} meses são apagados automaticamente,
          todos os dias. Os pedidos ficam anonimizados. Um cliente que volte a escrever sai da
          lista.
        </p>
        <ul class="due">
          @for (c of v.due; track c.contactId) {
            <li>
              <div class="due__who">
                <strong>{{ c.name || 'Sem nome' }}</strong>
                <div class="muted small">
                  {{ phone(c.phone) }} · última atividade {{ date(c.lastActivityAt, false) }}
                </div>
              </div>
              <div class="due__when small">
                <div>Apagado a</div>
                <strong>{{ date(c.deleteOn, false) }}</strong>
              </div>
            </li>
          } @empty {
            <li class="muted small">Ninguém será apagado nos próximos {{ v.days }} dias.</li>
          }
        </ul>
      </section>
    }
    @if (error()) {
      <p class="notice notice--error" role="alert">{{ error() }}</p>
    }
  `,
})
export class PrivacyRetentionPage {
  private readonly api = inject(AdminApi);
  protected readonly view = signal<PrivacyRetentionView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly phone = formatPhone;
  protected readonly date = formatDate;

  constructor() {
    this.api
      .client<PrivacyRetentionView>('GET', '/privacy/retention')
      .then((v) => this.view.set(v))
      .catch((e) =>
        this.error.set(
          e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.',
        ),
      );
  }
}
