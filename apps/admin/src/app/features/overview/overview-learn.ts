import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { GapReason, GapsView, GapTopic, OverviewProductsView } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { reasonShort, shortDay } from './overview.format';

const DAYS = 30;

/**
 * What to teach the assistant next (WA-029): the questions it could not answer, by topic
 * (admins: upload a document or dismiss), the most asked products and searches with no result.
 */
@Component({
  selector: 'app-overview-learn',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <p class="notice notice--error" role="alert">{{ error() }}</p>
    }

    @if (admin()) {
      <section class="learn">
        <h2 class="learn__title">O que o assistente não soube responder</h2>
        <p class="muted small learn__intro">
          Últimos {{ days }} dias. Perguntas em que ficou de confirmar com um colega, passou à
          equipa por falta de informação ou não encontrou nada. Carregue um documento para o
          ensinar.
        </p>
        @if (gaps(); as g) {
          @if (g.topics.length === 0) {
            <div class="card empty">
              <p class="empty__text">Nada por resolver. O assistente respondeu a tudo.</p>
            </div>
          }
          <ul class="gaps">
            @for (t of g.topics; track t.topic) {
              <li class="card gap">
                <div class="gap__head">
                  <h3 class="gap__topic">{{ t.topic }}</h3>
                  <span class="gap__count">{{ t.count }}</span>
                </div>
                <p class="gap__reasons small muted">{{ reasons(t) }}</p>
                <ul class="gap__examples">
                  @for (e of t.examples; track e.at) {
                    <li>
                      <q class="gap__q">{{ e.question }}</q>
                      <span class="small muted"> · {{ day(e.at) }}</span>
                      @if (e.reply) {
                        <span class="gap__reply small muted">Assistente: {{ e.reply }}</span>
                      }
                    </li>
                  }
                </ul>
                <div class="gap__actions">
                  <a class="btn btn--primary btn--sm" routerLink="/knowledge">
                    Carregar documento
                  </a>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    [disabled]="busy() === t.topic"
                    (click)="dismiss(t)"
                  >
                    Ignorar
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </section>
    }

    @if (products(); as p) {
      <div class="learn__grid">
        <section class="card">
          <h2 class="card__title">Produtos mais procurados</h2>
          @if (p.products.length) {
            <ol class="rank">
              @for (x of p.products; track x.productId) {
                <li>
                  <span class="rank__name">{{ x.title }}</span>
                  <span class="small muted">{{ x.conversations }} conv.</span>
                </li>
              }
            </ol>
          } @else {
            <p class="muted small">Ainda sem dados.</p>
          }
        </section>
        <section class="card">
          <h2 class="card__title">Pesquisas sem resultado</h2>
          <p class="muted small">Produtos que os clientes pedem e a loja não tem.</p>
          @if (p.missingSearches.length) {
            <ol class="rank">
              @for (x of p.missingSearches; track x.query) {
                <li>
                  <span class="rank__name">{{ x.query }}</span>
                  <span class="small muted">{{ x.conversations }} conv.</span>
                </li>
              }
            </ol>
          } @else {
            <p class="muted small">Nenhuma nos últimos {{ days }} dias.</p>
          }
        </section>
      </div>
    }
  `,
  styles: `
    .learn {
      margin-bottom: 16px;
    }
    .learn__title {
      font-size: 18px;
      margin: 8px 0 4px;
    }
    .learn__intro {
      margin: 0 0 10px;
    }
    .gaps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .gap__head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
    }
    .gap__topic {
      margin: 0;
      font-size: 16px;
    }
    .gap__count {
      font-size: 20px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .gap__reasons {
      margin: 2px 0 8px;
    }
    .gap__examples {
      margin: 0 0 10px;
      padding-left: 18px;
      display: grid;
      gap: 6px;
      overflow-wrap: anywhere;
    }
    .gap__reply {
      display: block;
    }
    .gap__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .learn__grid {
      display: grid;
      gap: 12px;
    }
    .rank {
      margin: 0;
      padding-left: 20px;
      display: grid;
      gap: 6px;
      font-size: 14px;
    }
    .rank li {
      overflow-wrap: anywhere;
    }
    .rank__name {
      margin-right: 6px;
    }
    @media (min-width: 900px) {
      .gaps,
      .learn__grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
})
export class OverviewLearn {
  private readonly api = inject(AdminApi);
  private readonly session = inject(SessionStore);

  readonly admin = input(false);
  protected readonly days = DAYS;
  protected day(iso: string): string {
    return shortDay(iso, this.session.context()?.client?.timezone);
  }
  protected readonly gaps = signal<GapsView | null>(null);
  protected readonly products = signal<OverviewProductsView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);

  constructor() {
    void this.loadProducts();
    effect(() => {
      if (this.admin()) void this.loadGaps();
    });
  }

  protected reasons(t: GapTopic): string {
    return (Object.entries(t.reasons) as [GapReason, number][])
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${reasonShort[r]} ${n}`)
      .join(' · ');
  }

  protected async dismiss(t: GapTopic): Promise<void> {
    this.busy.set(t.topic);
    try {
      await this.api.client('POST', '/overview/gaps/dismiss', { topic: t.topic });
      this.gaps.update((g) =>
        g ? { ...g, total: g.total - t.count, topics: g.topics.filter((x) => x !== t) } : g,
      );
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(null);
    }
  }

  private async loadGaps(): Promise<void> {
    try {
      this.gaps.set(await this.api.client<GapsView>('GET', `/overview/gaps?days=${DAYS}`));
    } catch (e) {
      this.fail(e);
    }
  }

  private async loadProducts(): Promise<void> {
    try {
      this.products.set(
        await this.api.client<OverviewProductsView>('GET', `/overview/products?days=${DAYS}`),
      );
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
  }
}
