import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  formatProductField,
  KNOWLEDGE_ACCEPT,
  type KnowledgeDocumentDetail,
  type KnowledgePassageView,
  type KnowledgeProposalView,
  type ProposalDecision,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import {
  confidence,
  fieldLabel,
  fieldValue,
  fileSize,
  shortDate,
  statusLabel,
  typeLabel,
} from './knowledge.format';

const POLL_MS = 3000;

const DECIDED: Record<string, string> = {
  approved: 'Aprovado',
  edited: 'Aprovado com alterações',
  rejected: 'Rejeitado',
};

/** A passage's text cut around the quote, so the quote can be marked. */
export function markQuote(
  text: string,
  quote: string | null,
): { before: string; mark: string; after: string } {
  const at = quote ? text.toLowerCase().indexOf(quote.trim().toLowerCase()) : -1;
  if (!quote || at < 0) return { before: text, mark: '', after: '' };
  const end = at + quote.trim().length;
  return { before: text.slice(0, at), mark: text.slice(at, end), after: text.slice(end) };
}

/** One document (WA-026): the proposals next to the text they were read from. */
@Component({
  selector: 'app-document-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <a routerLink=".." class="small kb-back">← Conhecimento</a>
        @if (detail(); as d) {
          <div class="kb-head">
            <h1 class="page__title kb-head__title">{{ d.document.name }}</h1>
            <span class="status" [attr.data-status]="d.document.status">{{
              statusLabel(d.document)
            }}</span>
          </div>
          <p class="muted small kb-head__meta">
            {{ typeLabel(d.document) }} · {{ fileSize(d.document.sizeBytes) }} · enviado
            {{ shortDate(d.document.createdAt) }}
            @if (d.document.uploadedBy) {
              por {{ d.document.uploadedBy }}
            }
            @if (session.isAdmin() && d.document.costUsd !== null) {
              · leitura {{ cost(d.document.costUsd) }}
            }
          </p>
          @if (session.isAdmin()) {
            <div class="kb-head__actions">
              <label class="btn btn--sm">
                Substituir ficheiro
                <input class="sr-only" type="file" [accept]="accept" (change)="replace($event)" />
              </label>
              <button type="button" class="btn btn--sm btn--danger" (click)="remove()">
                Eliminar
              </button>
            </div>
          }
        }
      </header>

      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }

      @if (detail(); as d) {
        @if (d.document.error) {
          <p class="notice" [class.notice--error]="d.document.status === 'failed'">
            {{ d.document.error }}
          </p>
        }
        @if (d.document.status === 'processing') {
          <div class="card empty"><p class="empty__text">A ler o documento…</p></div>
        } @else {
          <div class="kb-review">
            <section class="stack kb-review__proposals" aria-label="Dados propostos">
              <div class="kb-bar">
                <h2 class="card__title">Dados de produto ({{ d.proposals.length }})</h2>
                @if (session.isAdmin() && pending() > 0) {
                  <div class="kb-bar__actions">
                    <button
                      type="button"
                      class="btn btn--sm btn--primary"
                      [disabled]="busy()"
                      (click)="bulk('approve')"
                    >
                      Aprovar todos ({{ pending() }})
                    </button>
                    <button
                      type="button"
                      class="btn btn--sm"
                      [disabled]="busy()"
                      (click)="bulk('reject')"
                    >
                      Rejeitar todos
                    </button>
                  </div>
                }
              </div>
              @if (note()) {
                <p class="notice" role="status">{{ note() }}</p>
              }
              @if (d.proposals.length === 0) {
                <p class="muted small">Não foram encontrados dados de produto neste documento.</p>
              }
              @for (p of d.proposals; track p.id) {
                <article
                  class="card proposal"
                  [class.proposal--selected]="selected() === p.id"
                  [attr.data-status]="p.status"
                  (click)="select(p)"
                >
                  <div class="proposal__head">
                    <div class="proposal__product">
                      <strong>{{ p.productLabel }}</strong>
                      <span class="muted small">{{
                        p.productKey ?? 'sem produto no catálogo'
                      }}</span>
                    </div>
                    @if (p.page) {
                      <button
                        type="button"
                        class="proposal__page"
                        (click)="select(p); $event.stopPropagation()"
                      >
                        p. {{ p.page }}
                      </button>
                    }
                  </div>
                  <div class="proposal__value">
                    <span class="muted small">{{ fieldLabel(p.field) }}</span>
                    <span class="proposal__number">{{
                      fieldValue(p.field, p.finalValue ?? p.value)
                    }}</span>
                    <span class="conf" [class.conf--low]="p.confidence < 0.7">{{
                      confidence(p.confidence)
                    }}</span>
                  </div>
                  @if (p.current !== null && p.status === 'pending') {
                    <p class="muted small proposal__current">
                      Atual: {{ fieldValue(p.field, p.current) }}
                    </p>
                  }
                  @if (p.quote) {
                    <blockquote class="proposal__quote">“{{ p.quote }}”</blockquote>
                  }
                  @if (p.status !== 'pending') {
                    <p class="small proposal__decided">
                      {{ decided[p.status] }}
                      @if (p.decidedBy) {
                        por {{ p.decidedBy }}
                      }
                    </p>
                  }
                  @if (session.isAdmin() && editing() === p.id) {
                    <div class="proposal__edit" (click)="$event.stopPropagation()">
                      <label class="field">
                        <span class="field__label">{{ fieldLabel(p.field) }}</span>
                        <input
                          class="input input--sm"
                          [value]="draftValue()"
                          (input)="draftValue.set($any($event.target).value)"
                        />
                      </label>
                      <label class="field">
                        <span class="field__label">Produto (SKU ou handle)</span>
                        <input
                          class="input input--sm"
                          [value]="draftProduct()"
                          (input)="draftProduct.set($any($event.target).value)"
                        />
                      </label>
                      <div class="proposal__actions">
                        <button
                          type="button"
                          class="btn btn--sm btn--primary"
                          [disabled]="busy()"
                          (click)="saveEdit(p)"
                        >
                          Aprovar
                        </button>
                        <button
                          type="button"
                          class="btn btn--sm btn--ghost"
                          (click)="editing.set(null)"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  } @else if (session.isAdmin()) {
                    <div class="proposal__actions" (click)="$event.stopPropagation()">
                      @if (p.status === 'pending' || p.status === 'rejected') {
                        <button
                          type="button"
                          class="btn btn--sm btn--primary"
                          [disabled]="busy() || !p.productKey"
                          (click)="decide(p, { action: 'approve' })"
                        >
                          Aprovar
                        </button>
                      }
                      <button
                        type="button"
                        class="btn btn--sm"
                        [disabled]="busy()"
                        (click)="edit(p)"
                      >
                        Editar
                      </button>
                      @if (p.status !== 'rejected') {
                        <button
                          type="button"
                          class="btn btn--sm btn--ghost"
                          [disabled]="busy()"
                          (click)="decide(p, { action: 'reject' })"
                        >
                          Rejeitar
                        </button>
                      }
                    </div>
                  }
                </article>
              }
            </section>

            <section class="card kb-source" aria-label="Texto do documento">
              <h2 class="card__title">Texto do documento</h2>
              @if (d.passages.length === 0) {
                <p class="muted small">Sem texto extraído.</p>
              }
              @for (s of d.passages; track s.page) {
                <article
                  class="passage"
                  [id]="'passage-' + s.page"
                  [class.passage--selected]="selectedPage() === s.page"
                >
                  <h3 class="passage__label">{{ s.label ?? 'p. ' + s.page }}</h3>
                  @let m = marked(s);
                  <p class="passage__text">
                    {{ m.before }}<mark>{{ m.mark }}</mark
                    >{{ m.after }}
                  </p>
                </article>
              }
            </section>
          </div>
        }
      } @else if (!error()) {
        <p class="muted">A carregar…</p>
      }
    </section>
  `,
})
export class DocumentPage {
  private readonly api = inject(AdminApi);
  private readonly router = inject(Router);
  protected readonly session = inject(SessionStore);
  /** Route parameter (component input binding). */
  readonly id = input.required<string>();

  protected readonly accept = KNOWLEDGE_ACCEPT;
  protected readonly decided = DECIDED;
  protected readonly statusLabel = statusLabel;
  protected readonly typeLabel = typeLabel;
  protected readonly fileSize = fileSize;
  protected readonly shortDate = shortDate;
  protected readonly fieldLabel = fieldLabel;
  protected readonly fieldValue = fieldValue;
  protected readonly confidence = confidence;

  protected readonly detail = signal<KnowledgeDocumentDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly selected = signal<string | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly draftValue = signal('');
  protected readonly draftProduct = signal('');
  protected readonly pending = computed(
    () => this.detail()?.proposals.filter((p) => p.status === 'pending').length ?? 0,
  );
  protected readonly selectedPage = computed(() => {
    const p = this.detail()?.proposals.find((x) => x.id === this.selected());
    return p?.page ?? null;
  });
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    queueMicrotask(() => void this.load());
  }

  protected marked(s: KnowledgePassageView) {
    const p = this.detail()?.proposals.find((x) => x.id === this.selected());
    return markQuote(s.text, p && p.page === s.page ? p.quote : null);
  }

  protected cost(usd: number): string {
    return `${usd.toLocaleString('pt-PT', { maximumFractionDigits: 3 })} USD`;
  }

  protected select(p: KnowledgeProposalView): void {
    this.selected.set(p.id);
    if (p.page)
      document
        .getElementById(`passage-${p.page}`)
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  protected edit(p: KnowledgeProposalView): void {
    this.editing.set(p.id);
    this.draftValue.set(formatProductField(p.field, p.finalValue ?? p.value));
    this.draftProduct.set(p.productKey ?? '');
  }

  protected async saveEdit(p: KnowledgeProposalView): Promise<void> {
    const product = this.draftProduct().trim();
    const ok = await this.decide(p, {
      action: 'approve',
      value: this.draftValue(),
      ...(product && product !== p.productKey && { productKey: product }),
    });
    if (ok) this.editing.set(null);
  }

  protected async decide(p: KnowledgeProposalView, decision: ProposalDecision): Promise<boolean> {
    return this.run(async () => {
      const updated = await this.api.client<KnowledgeProposalView>(
        'POST',
        `/knowledge/proposals/${p.id}`,
        decision,
      );
      this.detail.update(
        (d) => d && { ...d, proposals: d.proposals.map((x) => (x.id === p.id ? updated : x)) },
      );
      await this.refreshDocument();
    });
  }

  protected async bulk(action: 'approve' | 'reject'): Promise<void> {
    const n = this.pending();
    const verb = action === 'approve' ? 'Aprovar' : 'Rejeitar';
    if (!confirm(`${verb} ${n} ${n === 1 ? 'proposta' : 'propostas'} pendentes?`)) return;
    await this.run(async () => {
      const r = await this.api.client<{ decided: number; skipped: number }>(
        'POST',
        `/knowledge/documents/${this.id()}/proposals`,
        { action },
      );
      this.note.set(
        r.skipped
          ? `${r.decided} decididas. ${r.skipped} sem produto do catálogo: edite-as para escolher o produto.`
          : `${r.decided} decididas.`,
      );
      await this.load();
    });
  }

  protected async replace(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const form = new FormData();
    form.set('file', file, file.name);
    await this.run(async () => {
      await this.api.client('PUT', `/knowledge/documents/${this.id()}`, form);
      await this.load();
    });
  }

  protected async remove(): Promise<void> {
    const d = this.detail();
    if (!d || !confirm(`Eliminar ${d.document.name}?`)) return;
    const approved = d.document.proposals.approved;
    const removeData =
      approved > 0 &&
      confirm(
        `Também retirar os ${approved} dados aprovados deste documento dos produtos? Cancelar mantém-nos.`,
      );
    await this.run(async () => {
      await this.api.client('DELETE', `/knowledge/documents/${this.id()}?removeData=${removeData}`);
      await this.router.navigate(['/knowledge']);
    });
  }

  private async refreshDocument(): Promise<void> {
    const { document } = await this.api.client<KnowledgeDocumentDetail>(
      'GET',
      `/knowledge/documents/${this.id()}`,
    );
    this.detail.update((d) => d && { ...d, document });
  }

  private async load(): Promise<void> {
    clearTimeout(this.timer);
    try {
      const d = await this.api.client<KnowledgeDocumentDetail>(
        'GET',
        `/knowledge/documents/${this.id()}`,
      );
      this.detail.set(d);
      if (d.document.status === 'processing')
        this.timer = setTimeout(() => void this.load(), POLL_MS);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    }
  }

  private async run(action: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      return true;
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
