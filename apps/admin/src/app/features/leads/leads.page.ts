import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  leadStatuses,
  leadStatusLabels,
  leadTypeLabel,
  type AdminLeadListItem,
  type AdminMember,
  type LeadStatus,
} from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import {
  errorMessage,
  LeadsData,
  nextStatuses,
  personName,
  shortBranch,
  shortDate,
  waitingLabel,
  type LeadFilters,
  type StatusChange,
} from './leads.data';
import { StatusBadge, StatusChips } from './status-chips';

const PAGE = 50;

/** The type filter: requests (info, quote, sample), order drafts, handoffs. */
const TYPE_OPTIONS = [
  { value: '', label: 'Todos os tipos' },
  { value: 'info,quote,sample', label: 'Pedidos' },
  { value: 'order', label: 'Encomendas' },
  { value: 'handoff', label: 'Passagens para a equipa' },
];

/** Pedidos (WA-024): every lead, order draft and handoff, newest first. */
@Component({
  selector: 'app-leads-page',
  imports: [RouterLink, StatusBadge, StatusChips],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head leads__head">
        <h1 class="page__title">Pedidos</h1>
        <button type="button" class="btn btn--sm" [disabled]="exporting()" (click)="exportCsv()">
          Exportar CSV
        </button>
      </header>

      <div class="card filters">
        <input
          class="input"
          type="search"
          placeholder="Procurar nome, telefone ou produto"
          aria-label="Procurar"
          [value]="filters().q"
          (input)="search($any($event.target).value)"
        />
        <div class="filters__row">
          <select
            class="input input--sm"
            aria-label="Tipo"
            [value]="filters().type"
            (change)="set({ type: $any($event.target).value })"
          >
            @for (t of typeOptions; track t.value) {
              <option [value]="t.value">{{ t.label }}</option>
            }
          </select>
          @if (session.branches().length > 1) {
            <select
              class="input input--sm"
              aria-label="Filial"
              [value]="filters().branch"
              (change)="set({ branch: $any($event.target).value })"
            >
              <option value="">Todas as filiais</option>
              @for (b of session.branches(); track b.id) {
                <option [value]="b.id" [selected]="b.id === filters().branch">
                  {{ branch(b.name) }}
                </option>
              }
            </select>
          }
          <select
            class="input input--sm"
            aria-label="Responsável"
            [value]="filters().owner"
            (change)="set({ owner: $any($event.target).value })"
          >
            <option value="">Todos os responsáveis</option>
            <option value="me">Os meus</option>
            <option value="none">Sem responsável</option>
            @for (m of members(); track m.id) {
              <option [value]="m.id" [selected]="m.id === filters().owner">
                {{ m.name || m.email }}
              </option>
            }
          </select>
        </div>
        <div class="filters__status" role="group" aria-label="Estado">
          @for (s of statuses; track s) {
            <button
              type="button"
              class="fchip"
              [class.fchip--on]="filters().status.includes(s)"
              [attr.aria-pressed]="filters().status.includes(s)"
              (click)="toggleStatus(s)"
            >
              {{ statusLabels[s] }}
            </button>
          }
        </div>
      </div>

      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }

      @if (loaded() && !items().length) {
        <div class="card empty">
          <p class="empty__text">Nenhum pedido com estes filtros.</p>
        </div>
      }

      <!-- Phones: one card per lead. -->
      <ul class="lcards">
        @for (l of items(); track l.id) {
          <li class="card lcard">
            <a class="lcard__link" [routerLink]="l.id">
              <div class="lcard__top">
                <span class="lname">{{ l.name || l.phone || 'Cliente' }}</span>
                <app-status-badge [status]="l.status" />
              </div>
              <div class="small muted">
                {{ typeLabel(l.type) }} · {{ branch(l.branchName) }} ·
                {{ date(l.createdAt) }}
              </div>
              @if (l.products || l.summary) {
                <div class="lcard__what">{{ l.products || l.summary }}</div>
              }
              <div class="small lcard__meta">
                <span>{{ owner(l) }}</span>
                @if (l.waitingHours) {
                  <span class="wait" [class.wait--late]="l.overdue">
                    {{ l.overdue ? 'Sem resposta há ' : 'Há ' }}{{ waiting(l.waitingHours) }}
                  </span>
                }
              </div>
            </a>
            @if (next(l.status).length) {
              <app-status-chips
                [options]="next(l.status)"
                [disabled]="busy() === l.id"
                (changed)="change(l, $event)"
              />
            }
          </li>
        }
      </ul>

      <!-- Desktops: a table. -->
      @if (items().length) {
        <div class="card ltable-wrap">
          <table class="ltable">
            <thead>
              <tr>
                <th>Recebido</th>
                <th>Cliente</th>
                <th>Pedido</th>
                <th>Filial</th>
                <th>Responsável</th>
                <th>Estado</th>
                <th><span class="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              @for (l of items(); track l.id) {
                <tr>
                  <td class="nowrap">
                    {{ date(l.createdAt) }}
                    @if (l.waitingHours) {
                      <div class="small wait" [class.wait--late]="l.overdue">
                        {{ waiting(l.waitingHours) }}
                      </div>
                    }
                  </td>
                  <td>
                    <a class="lname" [routerLink]="l.id">{{ l.name || l.phone || 'Cliente' }}</a>
                    @if (l.name && l.phone) {
                      <div class="small muted">{{ l.phone }}</div>
                    }
                  </td>
                  <td>
                    <div>{{ typeLabel(l.type) }}</div>
                    <div class="small muted clamp">{{ l.products || l.summary }}</div>
                  </td>
                  <td>{{ branch(l.branchName) }}</td>
                  <td>{{ owner(l) }}</td>
                  <td>
                    <app-status-badge [status]="l.status" />
                  </td>
                  <td class="ltable__actions">
                    <app-status-chips
                      [options]="next(l.status)"
                      [disabled]="busy() === l.id"
                      (changed)="change(l, $event)"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if (items().length < total()) {
        <div class="center more">
          <button type="button" class="btn" [disabled]="loading()" (click)="more()">
            Mostrar mais ({{ total() - items().length }})
          </button>
        </div>
      }
    </section>
  `,
  styles: `
    .leads__head {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
    .filters {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 12px;
      padding: 12px;
    }
    .filters__row,
    .filters__status {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filters__row .input {
      flex: 1 1 140px;
      max-width: 100%;
    }
    .fchip {
      padding: 4px 12px;
      min-height: 32px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fff;
      font-size: 13px;
    }
    .fchip--on {
      background: var(--teal);
      border-color: var(--teal);
      color: #fff;
    }
    .lcards {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .lcard {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .lcard__link {
      color: inherit;
      text-decoration: none;
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .lcard__top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .lname {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .lcard__what,
    .clamp {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow-wrap: anywhere;
    }
    .lcard__meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 10px;
      color: #3b4a54;
    }
    .wait {
      color: var(--muted);
    }
    .wait--late {
      color: var(--danger);
      font-weight: 600;
    }
    .ltable-wrap {
      display: none;
      padding: 0;
      overflow-x: auto;
    }
    .ltable {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .ltable th {
      text-align: left;
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .ltable td {
      padding: 10px 12px;
      border-bottom: 1px solid #e9edef;
      vertical-align: top;
    }
    .ltable a {
      text-decoration: none;
    }
    .nowrap {
      white-space: nowrap;
    }
    .ltable__actions {
      min-width: 230px;
    }
    .more {
      margin-top: 14px;
    }
    @media (min-width: 900px) {
      .lcards {
        display: none;
      }
      .ltable-wrap {
        display: block;
      }
    }
  `,
})
export class LeadsPage {
  private readonly data = inject(LeadsData);
  private readonly api = inject(AdminApi);
  protected readonly session = inject(SessionStore);

  protected readonly statuses = leadStatuses;
  protected readonly statusLabels = leadStatusLabels;
  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly filters = this.data.filters;
  protected readonly items = signal<AdminLeadListItem[]>([]);
  protected readonly total = signal(0);
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly exporting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly members = signal<AdminMember[]>([]);
  protected readonly myId = computed(() => this.session.context()?.member.id);

  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Answers to an older filter are dropped. */
  private generation = 0;

  constructor() {
    void this.reload();
    void this.api
      .client<AdminMember[]>('GET', '/team')
      .then((list) => this.members.set(list.filter((m) => m.id !== this.myId())))
      .catch(() => undefined);
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
  }

  protected typeLabel = leadTypeLabel;
  protected date = shortDate;
  protected waiting = waitingLabel;
  protected next = nextStatuses;
  protected owner = (l: AdminLeadListItem) => personName(l.owner);
  protected branch = shortBranch;

  protected set(patch: Partial<LeadFilters>): void {
    this.filters.update((f) => ({ ...f, ...patch }));
    void this.reload();
  }

  protected search(q: string): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.set({ q }), 300);
  }

  protected toggleStatus(s: LeadStatus): void {
    const status = this.filters().status;
    this.set({ status: status.includes(s) ? status.filter((x) => x !== s) : [...status, s] });
  }

  private async reload(): Promise<void> {
    await this.fetch(0);
  }

  protected more(): Promise<void> {
    return this.fetch(this.items().length);
  }

  private async fetch(offset: number): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.data.list(this.filters(), { limit: PAGE, offset });
      if (generation !== this.generation) return;
      this.items.update((list) => (offset ? [...list, ...page.items] : page.items));
      this.total.set(page.total);
      this.loaded.set(true);
    } catch (e) {
      if (generation === this.generation) this.error.set(errorMessage(e));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected async change(lead: AdminLeadListItem, change: StatusChange): Promise<void> {
    this.busy.set(lead.id);
    this.error.set(null);
    try {
      const updated = await this.data.setStatus(lead.id, change);
      const { status, lostReason, owner, waitingHours, overdue } = updated;
      this.items.update((list) =>
        list.map((l) =>
          l.id === lead.id ? { ...l, status, lostReason, owner, waitingHours, overdue } : l,
        ),
      );
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }

  protected async exportCsv(): Promise<void> {
    this.exporting.set(true);
    this.error.set(null);
    try {
      await this.data.exportCsv(this.filters());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.exporting.set(false);
    }
  }
}
