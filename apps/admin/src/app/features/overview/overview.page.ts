import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { OverviewCount, OverviewFigures, OverviewView } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { OverviewLearn } from './overview-learn';
import { barWidth, duration, shortDay, usd } from './overview.format';
import { shortBranch } from '../leads/leads.data';

type Period = 'week' | 'month';

interface Tile {
  label: string;
  value: string;
  sub?: string;
}

/** Resumo (WA-029): this week's and this month's figures, per branch, and what to teach next. */
@Component({
  selector: 'app-overview-page',
  imports: [OverviewLearn],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">Resumo</h1>
        <div class="ov-controls">
          <div class="seg" role="group" aria-label="Período">
            <button
              type="button"
              [class.seg--on]="period() === 'week'"
              (click)="period.set('week')"
            >
              Esta semana
            </button>
            <button
              type="button"
              [class.seg--on]="period() === 'month'"
              (click)="period.set('month')"
            >
              Este mês
            </button>
          </div>
          @if (session.branches().length > 1) {
            <select class="input input--sm" aria-label="Filial" (change)="pickBranch($event)">
              <option value="">Todas as filiais</option>
              @for (b of session.branches(); track b.id) {
                <option [value]="b.id" [selected]="b.id === branch()">{{ short(b.name) }}</option>
              }
            </select>
          }
        </div>
      </header>

      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }

      @if (figures(); as f) {
        <p class="muted small ov-range">
          De {{ day(f.from) }} até agora{{ branchName() ? ' · ' + branchName() : '' }}
        </p>
        <ul class="tiles" aria-label="Números do período">
          @for (t of tiles(); track t.label) {
            <li class="tile card">
              <span class="tile__label">{{ t.label }}</span>
              <span class="tile__value">{{ t.value }}</span>
              @if (t.sub) {
                <span class="tile__sub muted">{{ t.sub }}</span>
              }
            </li>
          }
        </ul>

        <div class="ov-grid">
          @for (group of groups(); track group.title) {
            <section class="card">
              <h2 class="card__title">{{ group.title }}</h2>
              @if (group.rows.length) {
                <ul class="bars">
                  @for (r of group.rows; track r.key) {
                    <li class="bars__row" [title]="r.label + ': ' + r.count">
                      <span class="bars__label">{{ r.label }}</span>
                      <span class="bars__track">
                        <span
                          class="bars__fill"
                          [style.width.%]="width(r.count, group.rows)"
                        ></span>
                      </span>
                      <span class="bars__n">{{ r.count }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="muted small">Nada neste período.</p>
              }
            </section>
          }

          @if (view()!.branches.length > 1) {
            <section class="card">
              <h2 class="card__title">Por filial</h2>
              <table class="ov-table">
                <thead>
                  <tr>
                    <th scope="col">Filial</th>
                    <th scope="col">Pedidos</th>
                    <th scope="col">Passagens</th>
                    <th scope="col">Ganhos</th>
                    <th scope="col">Perdidos</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of view()!.branches; track b.branchId) {
                    <tr>
                      <th scope="row">{{ short(b.name) }}</th>
                      <td>{{ b[period()].leads }}</td>
                      <td>{{ b[period()].handoffs }}</td>
                      <td>{{ b[period()].won }}</td>
                      <td>{{ b[period()].lost }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        </div>
      } @else if (!error()) {
        <p class="muted">A carregar…</p>
      }

      <app-overview-learn [admin]="session.isAdmin()" />
    </section>
  `,
  styles: `
    .ov-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      background: #fff;
    }
    .seg button {
      border: 0;
      background: none;
      padding: 6px 14px;
      min-height: 36px;
      font: inherit;
      font-size: 14px;
      color: var(--text);
    }
    .seg .seg--on {
      background: var(--teal);
      color: #fff;
    }
    .ov-range {
      margin: -8px 0 12px;
    }
    .tiles {
      list-style: none;
      margin: 0 0 16px;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 12px;
      min-width: 0;
    }
    .tile__label {
      font-size: 13px;
      color: var(--muted);
    }
    .tile__value {
      font-size: 26px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .tile__sub {
      font-size: 12px;
    }
    .ov-grid {
      display: grid;
      gap: 12px;
      margin-bottom: 16px;
    }
    .bars {
      list-style: none;
      margin: 10px 0 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .bars__row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 2.5em;
      gap: 2px 8px;
      font-size: 14px;
    }
    .bars__track {
      grid-column: 1;
      height: 8px;
      border-radius: 4px;
      background: var(--page);
    }
    .bars__fill {
      display: block;
      height: 100%;
      border-radius: 4px;
      background: var(--teal);
    }
    .bars__n {
      grid-row: 1 / 3;
      grid-column: 2;
      align-self: center;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .ov-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .ov-table th,
    .ov-table td {
      padding: 6px 4px;
      text-align: right;
      border-top: 1px solid var(--border);
    }
    .ov-table th:first-child {
      text-align: left;
    }
    .ov-table thead th {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      border-top: 0;
    }
    @media (min-width: 900px) {
      .tiles {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .ov-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
})
export class OverviewPage {
  private readonly api = inject(AdminApi);
  protected readonly session = inject(SessionStore);

  protected readonly period = signal<Period>('week');
  protected readonly branch = signal<string>('');
  protected readonly view = signal<OverviewView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected day(iso: string): string {
    return shortDay(iso, this.session.context()?.client?.timezone);
  }
  protected readonly short = shortBranch;

  protected readonly figures = computed<OverviewFigures | null>(
    () => this.view()?.[this.period()] ?? null,
  );
  protected readonly branchName = computed(() =>
    this.branch()
      ? shortBranch(this.session.branches().find((b) => b.id === this.branch())?.name ?? null)
      : '',
  );

  protected readonly tiles = computed<Tile[]>(() => {
    const f = this.figures();
    if (!f) return [];
    const r = f.firstResponse;
    const tiles: Tile[] = [
      { label: 'Conversas', value: String(f.conversations) },
      { label: 'Pedidos', value: String(f.leads) },
      { label: 'Passagens para a equipa', value: String(f.handoffs) },
      {
        label: 'Orçamentados',
        value: String(f.quoted),
        sub: `${f.quotesSent} ${f.quotesSent === 1 ? 'orçamento enviado' : 'orçamentos enviados'}`,
      },
      { label: 'Ganhos', value: String(f.won) },
      { label: 'Perdidos', value: String(f.lost) },
      {
        label: '1.ª resposta da equipa',
        value: duration(r.medianWorkingMinutes),
        sub: `mediana em horário útil · ${r.waiting} por responder`,
      },
    ];
    if (f.cost) {
      tiles.push({
        label: 'Custo do Claude',
        value: usd(f.cost.totalUsd),
        sub: `${f.cost.turns} respostas · ficheiros ${usd(f.cost.documentsUsd)}`,
      });
    }
    return tiles;
  });

  protected readonly groups = computed<{ title: string; rows: OverviewCount[] }[]>(() => {
    const f = this.figures();
    if (!f) return [];
    return [
      { title: 'Pedidos por tipo', rows: f.leadsByType },
      { title: 'Passagens por motivo', rows: f.handoffsByReason },
      { title: 'Perdidos por motivo', rows: f.lostByReason },
    ];
  });

  constructor() {
    void this.load();
  }

  protected width(count: number, rows: OverviewCount[]): number {
    return barWidth(count, Math.max(...rows.map((r) => r.count)));
  }

  protected pickBranch(event: Event): void {
    this.branch.set((event.target as HTMLSelectElement).value);
    void this.load();
  }

  private async load(): Promise<void> {
    const branch = this.branch();
    try {
      this.view.set(
        await this.api.client<OverviewView>(
          'GET',
          `/overview${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
        ),
      );
      this.error.set(null);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    }
  }
}
