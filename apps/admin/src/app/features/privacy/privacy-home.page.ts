import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  confirmsCustomer,
  type PrivacyActionResult,
  type PrivacyCustomer,
  type PrivacyRequestView,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { PrivacyApi } from './privacy.api';
import { formatCounts, formatDate, formatPhone } from './privacy.format';

/**
 * Privacy home (WA-028): find a customer by name or number, then export their data, clear their
 * profile or delete them (typing their name or number to confirm).
 */
@Component({
  selector: 'app-privacy-home',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  styles: `
    .results {
      list-style: none;
      margin: 12px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .result {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: #fff;
      text-align: left;
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    .result--active {
      border-color: var(--teal);
      box-shadow: 0 0 0 1px var(--teal);
    }
    .result__name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .result__meta {
      text-align: right;
      white-space: nowrap;
    }
    .facts {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 4px 12px;
      margin: 10px 0 14px;
      font-size: 14px;
    }
    .facts dt {
      color: var(--muted);
    }
    .facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .danger-zone {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid var(--danger);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--danger) 6%, #fff);
    }
    .danger-zone .buttons {
      margin-top: 12px;
    }
    .danger-zone ul {
      margin: 6px 0 10px;
      padding-left: 20px;
      font-size: 14px;
    }
  `,
  template: `
    @if (pending() > 0) {
      <p class="notice" role="status">
        {{ pending() === 1 ? 'Há 1 pedido' : 'Há ' + pending() + ' pedidos' }} de clientes por
        tratar. <a routerLink="requests">Ver pedidos</a>
      </p>
    }

    <section class="card">
      <h2 class="card__title">Procurar cliente</h2>
      <label class="field">
        <span class="field__label">Nome ou número de WhatsApp</span>
        <input
          class="input"
          type="search"
          [value]="query()"
          (input)="search($any($event.target).value)"
          placeholder="Ex.: Ana Costa ou 912 345 678"
          autocomplete="off"
        />
      </label>
      <ul class="results">
        @for (c of results(); track c.contactId) {
          <li>
            <button
              type="button"
              class="result"
              [class.result--active]="c.contactId === selected()?.contactId"
              (click)="select(c)"
            >
              <span>
                <span class="result__name">{{ c.name || 'Sem nome' }}</span>
                <span class="muted small"> · {{ phone(c.phone) }}</span>
              </span>
              <span class="result__meta muted small">{{ date(c.lastActivityAt, false) }}</span>
            </button>
          </li>
        } @empty {
          @if (!busy()) {
            <li class="muted small">Nenhum cliente encontrado.</li>
          }
        }
      </ul>
    </section>

    @if (selected(); as c) {
      <section class="card" aria-live="polite">
        <h2 class="card__title">{{ c.name || 'Sem nome' }}</h2>
        <dl class="facts">
          <dt>WhatsApp</dt>
          <dd>{{ phone(c.phone) }}</dd>
          <dt>Cliente desde</dt>
          <dd>{{ date(c.createdAt, false) }}</dd>
          <dt>Última atividade</dt>
          <dd>{{ date(c.lastActivityAt, false) }}</dd>
          <dt>Conversas</dt>
          <dd>{{ c.conversations }}</dd>
          <dt>Pedidos</dt>
          <dd>{{ c.leads }}</dd>
          <dt>Perfil</dt>
          <dd>{{ c.profilingOptOut ? 'Limpo; sem personalização' : 'Ativo' }}</dd>
          @if (c.pendingRequests > 0) {
            <dt>Pedidos de privacidade</dt>
            <dd>
              <a routerLink="requests">{{ c.pendingRequests }} por tratar</a>
            </dd>
          }
        </dl>
        <div class="buttons">
          <button type="button" class="btn" (click)="exportData(c)" [disabled]="busy()">
            Exportar dados (ZIP)
          </button>
          <button
            type="button"
            class="btn"
            (click)="clearProfile(c)"
            [disabled]="busy() || c.profilingOptOut"
          >
            Limpar perfil
          </button>
          <button
            type="button"
            class="btn btn--danger"
            (click)="startDelete()"
            [disabled]="busy() || deleting()"
          >
            Apagar cliente
          </button>
        </div>

        @if (deleting()) {
          <form class="danger-zone" (submit)="$event.preventDefault(); deleteCustomer(c)">
            <strong>Apagar {{ c.name || phone(c.phone) }} definitivamente?</strong>
            <ul>
              <li>Apaga o contacto, as conversas, as mensagens, os ficheiros e os emails.</li>
              <li>Os pedidos ficam anonimizados, para as contagens e estatísticas.</li>
              <li>Não pode ser desfeito.</li>
            </ul>
            <label class="field">
              <span class="field__label">
                Para confirmar, escreva
                {{ c.name ? 'o nome (' + c.name + ') ou o número' : 'o número (' + c.phone + ')' }}
              </span>
              <input
                class="input"
                id="privacy-confirm"
                autocomplete="off"
                [value]="typed()"
                (input)="typed.set($any($event.target).value)"
              />
            </label>
            <div class="buttons">
              <button type="submit" class="btn btn--danger" [disabled]="!confirmed() || busy()">
                Apagar definitivamente
              </button>
              <button type="button" class="btn btn--ghost" (click)="deleting.set(false)">
                Cancelar
              </button>
            </div>
          </form>
        }
      </section>
    }

    @if (note()) {
      <p class="notice" role="status">{{ note() }}</p>
    }
    @if (error()) {
      <p class="notice notice--error" role="alert">{{ error() }}</p>
    }
  `,
})
export class PrivacyHomePage {
  private readonly api = inject(AdminApi);
  private readonly privacy = inject(PrivacyApi);

  protected readonly query = signal('');
  protected readonly results = signal<PrivacyCustomer[]>([]);
  protected readonly selected = signal<PrivacyCustomer | null>(null);
  protected readonly pending = signal(0);
  protected readonly deleting = signal(false);
  protected readonly typed = signal('');
  protected readonly busy = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmed = computed(() => {
    const c = this.selected();
    return !!c && confirmsCustomer(this.typed(), c);
  });
  protected readonly phone = formatPhone;
  protected readonly date = formatDate;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.load('');
    void this.api
      .client<PrivacyRequestView[]>('GET', '/privacy/requests?status=pending')
      .then((list) => this.pending.set(list.length))
      .catch(() => undefined);
  }

  protected search(q: string): void {
    this.query.set(q);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(q), 250);
  }

  protected select(c: PrivacyCustomer): void {
    this.selected.set(c);
    this.deleting.set(false);
    this.typed.set('');
    this.note.set(null);
    this.error.set(null);
  }

  protected startDelete(): void {
    this.typed.set('');
    this.deleting.set(true);
    setTimeout(() => document.getElementById('privacy-confirm')?.focus());
  }

  protected async exportData(c: PrivacyCustomer): Promise<void> {
    await this.run(async () => {
      await this.privacy.exportCustomer(c.contactId);
      this.note.set('Exportação descarregada. Fica registada no registo de privacidade.');
    });
  }

  protected async clearProfile(c: PrivacyCustomer): Promise<void> {
    if (
      !confirm(
        `Limpar o perfil de ${c.name || formatPhone(c.phone)}? As preferências guardadas são apagadas e as respostas deixam de ser personalizadas. O histórico mantém-se.`,
      )
    ) {
      return;
    }
    await this.run(async () => {
      await this.api.client<PrivacyActionResult>(
        'POST',
        `/privacy/customers/${c.contactId}/clear-profile`,
      );
      await this.refresh(c.contactId);
      this.note.set('Perfil limpo. Este cliente deixa de ter respostas personalizadas.');
    });
  }

  protected async deleteCustomer(c: PrivacyCustomer): Promise<void> {
    if (!this.confirmed()) return;
    await this.run(async () => {
      const { counts } = await this.api.client<PrivacyActionResult>(
        'POST',
        `/privacy/customers/${c.contactId}/delete`,
        { confirm: this.typed() },
      );
      this.selected.set(null);
      this.deleting.set(false);
      this.results.update((list) => list.filter((x) => x.contactId !== c.contactId));
      this.note.set(`Cliente apagado: ${formatCounts(counts)}.`);
    });
  }

  private async refresh(contactId: string): Promise<void> {
    const fresh = await this.api.client<PrivacyCustomer>('GET', `/privacy/customers/${contactId}`);
    this.selected.set(fresh);
    this.results.update((list) => list.map((x) => (x.contactId === contactId ? fresh : x)));
  }

  private async load(q: string): Promise<void> {
    await this.run(async () => {
      const list = await this.api.client<PrivacyCustomer[]>(
        'GET',
        `/privacy/customers?q=${encodeURIComponent(q.trim())}`,
      );
      if (q === this.query()) this.results.set(list);
    }, false);
  }

  private async run(action: () => Promise<void>, clearNote = true): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    if (clearNote) this.note.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    } finally {
      this.busy.set(false);
    }
  }
}
