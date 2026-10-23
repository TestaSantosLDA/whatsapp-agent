import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  customerRoleLabels,
  customerRoles,
  type CustomerListItem,
  type CustomerRole,
} from '@wa/shared';
import { CustomersData, errorMessage, formatPhone, shortDate } from './customers.data';

/** Clientes (WA-027): every customer record, the most recently active first. */
@Component({
  selector: 'app-customers-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">Clientes</h1>
      </header>

      <div class="card filters">
        <input
          class="input"
          type="search"
          placeholder="Procurar nome, empresa, NIF ou telefone"
          aria-label="Procurar"
          [value]="q()"
          (input)="search($any($event.target).value)"
        />
        <div class="roles" role="group" aria-label="Tipo de cliente">
          <button
            type="button"
            class="fchip"
            [class.fchip--on]="!role()"
            [attr.aria-pressed]="!role()"
            (click)="setRole('')"
          >
            Todos
          </button>
          @for (r of roles; track r) {
            <button
              type="button"
              class="fchip"
              [class.fchip--on]="role() === r"
              [attr.aria-pressed]="role() === r"
              (click)="setRole(r)"
            >
              {{ roleLabels[r] }}
            </button>
          }
        </div>
      </div>

      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }
      @if (loaded() && !items().length) {
        <div class="card empty">
          <p class="empty__text">Nenhum cliente encontrado.</p>
        </div>
      }

      <ul class="ccards">
        @for (c of items(); track c.id) {
          <li class="card ccard">
            <a class="ccard__link" [routerLink]="c.id">
              <div class="ccard__top">
                <span class="ccard__name">{{ c.name || phone(c.phones[0] ?? '') }}</span>
                @if (c.role) {
                  <span class="rtag">{{ roleLabels[c.role] }}</span>
                }
              </div>
              @if (c.company) {
                <div class="small">{{ c.company }}</div>
              }
              <div class="small muted">
                {{ phonesOf(c) }} · {{ c.conversations }}
                {{ c.conversations === 1 ? 'conversa' : 'conversas' }} · {{ c.leads }}
                {{ c.leads === 1 ? 'pedido' : 'pedidos' }} · {{ date(c.lastActivityAt) }}
              </div>
              @if (c.profiling === 'opted_out') {
                <div class="small muted">Sem personalização (o cliente opôs-se)</div>
              }
            </a>
          </li>
        }
      </ul>
      @if (total() > items().length) {
        <button type="button" class="btn btn--sm more" [disabled]="busy()" (click)="more()">
          Mostrar mais ({{ total() - items().length }})
        </button>
      }
    </section>
  `,
  styles: `
    .filters {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 12px;
    }
    .roles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .fchip {
      border: 1px solid var(--border);
      background: #fff;
      border-radius: 16px;
      padding: 5px 11px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .fchip--on {
      background: var(--teal);
      border-color: var(--teal);
      color: #fff;
    }
    .ccards {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .ccard {
      padding: 0;
    }
    .ccard__link {
      display: block;
      padding: 14px 16px;
      color: inherit;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .ccard__top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 2px;
    }
    .ccard__name {
      font-weight: 600;
    }
    .rtag {
      font-size: 11px;
      font-weight: 600;
      color: #20403a;
      background: var(--teal-soft);
      border-radius: 9px;
      padding: 1px 7px;
    }
    .more {
      margin-top: 12px;
    }
    @media (min-width: 900px) {
      .ccards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
})
export class CustomersPage {
  private readonly data = inject(CustomersData);

  protected readonly roles = customerRoles;
  protected readonly roleLabels = customerRoleLabels;
  protected readonly q = signal('');
  protected readonly role = signal<CustomerRole | ''>('');
  protected readonly items = signal<CustomerListItem[]>([]);
  protected readonly total = signal(0);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected phone = formatPhone;
  protected date = shortDate;
  protected phonesOf = (c: CustomerListItem) => c.phones.map(formatPhone).join(', ');

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    void this.load();
  }

  protected search(q: string): void {
    this.q.set(q);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 250);
  }

  protected setRole(role: CustomerRole | ''): void {
    this.role.set(role);
    void this.load();
  }

  protected more(): Promise<void> {
    return this.load(this.items().length);
  }

  private async load(offset = 0): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const page = await this.data.list(this.q(), this.role(), offset);
      this.items.set(offset ? [...this.items(), ...page.items] : page.items);
      this.total.set(page.total);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
      this.loaded.set(true);
    }
  }
}
