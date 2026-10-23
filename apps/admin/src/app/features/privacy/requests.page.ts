import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  confirmsCustomer,
  type PrivacyActionResult,
  type PrivacyRequestStatus,
  type PrivacyRequestView,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { PrivacyApi } from './privacy.api';
import {
  formatCounts,
  formatDate,
  formatPhone,
  requestStatusLabel,
  requestTypeLabel,
} from './privacy.format';

/**
 * Privacy requests (WA-028): what customers asked for on WhatsApp ("apague os meus dados"). An
 * admin approves (the action runs and the customer is told on WhatsApp) or rejects.
 */
@Component({
  selector: 'app-privacy-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  styles: `
    .filters {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .requests {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .request__head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }
    .request__who {
      margin: 4px 0 10px;
      overflow-wrap: anywhere;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .tag--pending {
      background: color-mix(in srgb, #e6a700 18%, #fff);
    }
  `,
  template: `
    <div class="filters" role="group" aria-label="Estado">
      @for (f of filters; track f.value) {
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="status() === f.value"
          (click)="show(f.value)"
        >
          {{ f.label }}
        </button>
      }
    </div>

    <ul class="requests">
      @for (r of requests(); track r.id) {
        <li class="card">
          <div class="request__head">
            <h2 class="card__title">{{ typeLabel[r.type] }}</h2>
            <span class="tag" [class.tag--pending]="r.status === 'pending'">{{
              statusLabel[r.status]
            }}</span>
          </div>
          <p class="request__who">
            @if (r.customer; as c) {
              <strong>{{ c.name || 'Sem nome' }}</strong> · {{ phone(c.phone) }}
            } @else {
              <span class="muted">Cliente apagado</span>
            }
            <br />
            <span class="muted small">
              {{ r.source === 'whatsapp' ? 'Pedido no WhatsApp' : 'Pedido no painel' }} ·
              {{ date(r.createdAt) }}
            </span>
          </p>
          @if (r.status !== 'pending') {
            <p class="muted small">
              {{ statusLabel[r.status] }} por {{ r.decidedBy || 'um administrador' }} em
              {{ date(r.decidedAt) }}
              @if (r.result) {
                · {{ counts(r.result) }}
              }
            </p>
          } @else if (r.customer; as c) {
            @if (r.type === 'delete') {
              <label class="field">
                <span class="field__label">
                  Para aprovar, escreva o nome ou o número do cliente
                </span>
                <input
                  class="input"
                  autocomplete="off"
                  [attr.aria-label]="'Confirmar ' + (c.name || c.phone)"
                  [value]="typed()[r.id] ?? ''"
                  (input)="type(r.id, $any($event.target).value)"
                />
              </label>
            }
            <div class="buttons">
              @if (r.type === 'export') {
                <button type="button" class="btn" (click)="download(r)" [disabled]="busy()">
                  Descarregar ZIP
                </button>
              }
              <button
                type="button"
                class="btn"
                [class.btn--danger]="r.type === 'delete'"
                [class.btn--primary]="r.type !== 'delete'"
                [disabled]="busy() || (r.type === 'delete' && !confirms(r))"
                (click)="approve(r)"
              >
                {{ approveLabel[r.type] }}
              </button>
              <button type="button" class="btn btn--ghost" (click)="reject(r)" [disabled]="busy()">
                Rejeitar
              </button>
            </div>
          }
        </li>
      } @empty {
        <li class="card empty">
          <p class="empty__text">
            {{ status() === 'pending' ? 'Não há pedidos por tratar.' : 'Ainda não há pedidos.' }}
          </p>
          <p class="muted small">
            Quando um cliente pede no WhatsApp para apagar os seus dados, o pedido aparece aqui.
          </p>
        </li>
      }
    </ul>

    @if (note()) {
      <p class="notice" role="status">{{ note() }}</p>
    }
    @if (error()) {
      <p class="notice notice--error" role="alert">{{ error() }}</p>
    }
  `,
})
export class PrivacyRequestsPage {
  private readonly api = inject(AdminApi);
  private readonly privacy = inject(PrivacyApi);

  protected readonly filters: { value: PrivacyRequestStatus | 'all'; label: string }[] = [
    { value: 'pending', label: 'Por tratar' },
    { value: 'all', label: 'Todos' },
  ];
  protected readonly typeLabel = requestTypeLabel;
  protected readonly statusLabel = requestStatusLabel;
  protected readonly approveLabel = {
    delete: 'Aprovar e apagar',
    clear_profile: 'Aprovar e limpar perfil',
    export: 'Marcar como enviado',
  };
  protected readonly phone = formatPhone;
  protected readonly date = formatDate;
  protected readonly counts = formatCounts;

  protected readonly status = signal<PrivacyRequestStatus | 'all'>('pending');
  protected readonly requests = signal<PrivacyRequestView[]>([]);
  protected readonly typed = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected show(status: PrivacyRequestStatus | 'all'): void {
    this.status.set(status);
    void this.load();
  }

  protected type(id: string, value: string): void {
    this.typed.update((t) => ({ ...t, [id]: value }));
  }

  protected confirms(r: PrivacyRequestView): boolean {
    return !!r.customer && confirmsCustomer(this.typed()[r.id] ?? '', r.customer);
  }

  protected async download(r: PrivacyRequestView): Promise<void> {
    if (!r.customer) return;
    await this.run(() => this.privacy.exportCustomer(r.customer!.contactId));
  }

  protected async approve(r: PrivacyRequestView): Promise<void> {
    await this.run(async () => {
      const result = await this.api.client<PrivacyActionResult>(
        'POST',
        `/privacy/requests/${r.id}/approve`,
        r.type === 'delete' ? { confirm: this.typed()[r.id] ?? '' } : {},
      );
      this.note.set(
        `Pedido concluído${r.type === 'delete' ? `: ${formatCounts(result.counts)}` : ''}. ${
          result.notified
            ? 'O cliente foi avisado no WhatsApp.'
            : 'Não foi possível avisar o cliente no WhatsApp.'
        }`,
      );
      await this.load(false);
    });
  }

  protected async reject(r: PrivacyRequestView): Promise<void> {
    if (!confirm('Rejeitar este pedido? O cliente é avisado de que um colega o vai contactar.')) {
      return;
    }
    await this.run(async () => {
      await this.api.client<PrivacyActionResult>('POST', `/privacy/requests/${r.id}/reject`);
      this.note.set('Pedido rejeitado. Contacte o cliente para o esclarecer.');
      await this.load(false);
    });
  }

  private async load(clear = true): Promise<void> {
    const status = this.status();
    const run = async () => {
      this.requests.set(
        await this.api.client<PrivacyRequestView[]>(
          'GET',
          `/privacy/requests${status === 'all' ? '' : `?status=${status}`}`,
        ),
      );
    };
    if (clear) await this.run(run);
    else await run();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.note.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    } finally {
      this.busy.set(false);
    }
  }
}
