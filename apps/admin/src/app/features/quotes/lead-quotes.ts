import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { formatCents, quoteStatusLabels, type QuoteListItem } from '@wa/shared';
import { errorMessage, shortDate } from '../leads/leads.data';
import { QuotesData } from './quotes.data';

/** The "Orçamentos" card on a lead's page (WA-025): its quotes, and "Criar orçamento". */
@Component({
  selector: 'app-lead-quotes',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="qhead">
        <h2 class="card__title">Orçamentos</h2>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          [disabled]="busy()"
          (click)="create()"
        >
          Criar orçamento
        </button>
      </div>
      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }
      <ul class="plain">
        @for (q of quotes(); track q.id) {
          <li>
            <a [routerLink]="['/quotes', q.id]">{{ q.number }}</a>
            <span class="tag">{{ label(q) }}</span>
            <span class="small muted">
              {{ money(q.totalCents) }} ·
              {{ q.sentAt ? 'enviado ' + date(q.sentAt) : 'criado ' + date(q.createdAt) }}
            </span>
          </li>
        } @empty {
          <li class="small muted">
            Ainda sem orçamentos. O novo orçamento já traz os produtos e as quantidades da conversa.
          </li>
        }
      </ul>
    </section>
  `,
  styles: `
    .qhead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .plain {
      list-style: none;
      margin: 10px 0 0;
      padding: 0;
    }
    .plain li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 10px;
      padding: 8px 0;
      border-top: 1px solid #e9edef;
    }
  `,
})
export class LeadQuotes {
  private readonly data = inject(QuotesData);
  private readonly router = inject(Router);

  readonly leadId = input.required<string>();

  protected readonly quotes = signal<QuoteListItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected money = formatCents;
  protected date = shortDate;
  protected label = (q: QuoteListItem) => quoteStatusLabels[q.status];

  constructor() {
    effect(() => {
      const id = this.leadId();
      this.data.forLead(id).then(
        (list) => this.quotes.set(list),
        (e: unknown) => this.error.set(errorMessage(e)),
      );
    });
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const q = await this.data.create(this.leadId());
      await this.router.navigate(['/quotes', q.id]);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
