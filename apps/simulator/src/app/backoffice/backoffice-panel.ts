import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { BackofficeLead, BackofficeToolCall } from '@wa/shared';
import { BackofficeStore } from '../core/backoffice.store';

const LEAD_TYPES: Record<string, string> = {
  info: 'Pedido de informação',
  quote: 'Pedido de orçamento',
  sample: 'Pedido de amostra',
  order: 'Encomenda',
  handoff: 'Passagem para humano',
};

const EMAIL_KINDS: Record<string, string> = {
  lead: 'Lead',
  handoff: 'Passagem',
  order_draft: 'Rascunho de encomenda',
  inbox_alert: 'Alerta à equipa',
  quote: 'Orçamento ao cliente',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Nome',
  phone: 'Telefone',
  email: 'Email',
  location: 'Localidade',
  postal_code: 'Código postal',
  area: 'Área',
  quantity: 'Quantidade',
  products: 'Produtos',
  product: 'Produto',
  summary: 'Resumo',
  reason: 'Motivo',
  language: 'Idioma',
  notes: 'Notas',
};

const FIELD_ORDER = Object.keys(FIELD_LABELS);

const STATUS_LABELS = { bot: 'Bot', human: 'Humano', closed: 'Encerrada' } as const;

const time = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit' });
const usd = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const int = new Intl.NumberFormat('pt-PT');

@Component({
  selector: 'app-backoffice-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="bo__head">
      <h2 id="panel-title" class="panel__title">Back-office</h2>
      @if (store.connection() === 'retrying') {
        <span class="bo__conn">A religar…</span>
      }
      <label class="bo__switch">
        <input
          type="checkbox"
          [checked]="store.showTrace()"
          (change)="store.setShowTrace($any($event.target).checked)"
        />
        Trace do agente
      </label>
    </header>

    <section class="bo__section" aria-labelledby="bo-conv">
      <h3 id="bo-conv" class="bo__h">Conversa</h3>
      <div class="bo__conv">
        @if (store.status(); as s) {
          <span [class]="'badge badge--' + s">{{ statusLabel(s) }}</span>
          @if (s === 'human') {
            <span class="bo__muted"
              >Um colaborador assumiu a conversa; o bot está em silêncio.</span
            >
            <button
              type="button"
              class="btn btn--primary bo__bot-btn"
              [disabled]="store.returning()"
              (click)="store.returnToBot()"
            >
              Devolver ao bot
            </button>
          } @else if (s === 'bot') {
            <span class="bo__muted">O bot está a responder.</span>
          }
        } @else {
          <span class="bo__muted">A carregar…</span>
        }
      </div>
      @if (store.notice(); as n) {
        <p class="bo__notice" role="status">{{ n }}</p>
      }
    </section>

    <section class="bo__section" aria-labelledby="bo-leads">
      <h3 id="bo-leads" class="bo__h">
        Leads <span class="bo__count">{{ store.leads().length }}</span>
      </h3>
      @for (lead of store.leads(); track lead.id) {
        <article class="lead">
          <div class="lead__top">
            <span class="lead__type">{{ leadType(lead.type) }}</span>
            <span class="bo__time">{{ at(lead.createdAt) }}</span>
          </div>
          <div class="lead__branch">
            @if (lead.branchName ?? lead.branchId; as b) {
              Encaminhado para <strong>{{ b }}</strong>
            } @else {
              Sem loja atribuída
            }
            · {{ lead.status === 'new' ? 'Nova' : lead.status }}
          </div>
          @if (fields(lead).length) {
            <dl class="kv">
              @for (f of fields(lead); track f.key) {
                <dt>{{ f.label }}</dt>
                <dd>{{ f.value }}</dd>
              }
            </dl>
          }
        </article>
      } @empty {
        <p class="bo__empty">
          Ainda sem leads. Aparecem aqui assim que o agente regista um pedido.
        </p>
      }
    </section>

    <section class="bo__section" aria-labelledby="bo-emails">
      <h3 id="bo-emails" class="bo__h">
        Emails <span class="bo__count">{{ store.emails().length }}</span>
      </h3>
      @for (email of store.emails(); track email.id) {
        <div class="mail" [class.mail--open]="openEmail() === email.id">
          <button
            type="button"
            class="mail__row"
            [attr.aria-expanded]="openEmail() === email.id"
            (click)="toggleEmail(email.id)"
          >
            <span class="mail__subject">{{ email.subject }}</span>
            <span class="bo__time">{{ at(email.createdAt) }}</span>
            <span class="mail__to">
              {{ emailKind(email.kind) }} · para {{ email.to.join(', ') }}
              @if (email.error) {
                · <span class="mail__err">erro</span>
              } @else if (!email.sentAt) {
                · por enviar
              }
            </span>
          </button>
          @if (openEmail() === email.id) {
            <div class="mail__body">
              <dl class="kv">
                <dt>Para</dt>
                <dd>{{ email.to.join(', ') }}</dd>
                <dt>Assunto</dt>
                <dd>{{ email.subject }}</dd>
                @if (email.error) {
                  <dt>Erro</dt>
                  <dd class="mail__err">{{ email.error }}</dd>
                }
              </dl>
              <pre class="mail__text">{{ email.body }}</pre>
            </div>
          }
        </div>
      } @empty {
        <p class="bo__empty">Nenhum email enviado nesta conversa.</p>
      }
    </section>

    @if (store.showTrace()) {
      <section class="bo__section" aria-labelledby="bo-trace">
        <h3 id="bo-trace" class="bo__h">
          Trace do agente <span class="bo__count">{{ store.turns().length }}</span>
        </h3>
        @if (store.turns().length) {
          <p class="bo__muted trace__total">
            Total: {{ num(totals().tokens) }} tokens · {{ cost(totals().cost) }}
          </p>
        }
        @for (turn of store.turns(); track turn.id; let i = $index) {
          <details class="turn">
            <summary>
              <strong>Turno {{ i + 1 }}</strong>
              <span>{{ turn.toolCalls.length }} ferramenta(s)</span>
              <span>{{ cost(turn.costUsd) }}</span>
              <span>{{ turn.latencyMs === null ? '—' : num(turn.latencyMs) + ' ms' }}</span>
              @if (turn.error) {
                <span class="mail__err">erro</span>
              }
            </summary>
            <dl class="kv kv--compact">
              <dt>Modelo</dt>
              <dd>{{ turn.model }}</dd>
              <dt>Tokens</dt>
              <dd>{{ num(turn.inputTokens) }} entrada · {{ num(turn.outputTokens) }} saída</dd>
              <dt>Cache</dt>
              <dd>{{ num(turn.cacheReadTokens) }} lidos da cache</dd>
              <dt>Custo</dt>
              <dd>{{ cost(turn.costUsd) }}</dd>
              <dt>Latência</dt>
              <dd>{{ turn.latencyMs === null ? '—' : num(turn.latencyMs) + ' ms' }}</dd>
              @if (turn.error) {
                <dt>Erro</dt>
                <dd class="mail__err">{{ turn.error }}</dd>
              }
            </dl>
            @for (call of turn.toolCalls; track $index) {
              <details class="tool">
                <summary>
                  <code>{{ call.name }}</code>
                  <span [class]="call.ok ? 'tool__ok' : 'tool__fail'">{{
                    call.ok ? 'ok' : 'falhou'
                  }}</span>
                  <span class="bo__time">{{ call.ms }} ms</span>
                </summary>
                <div class="tool__label">Entrada</div>
                <pre class="tool__pre">{{ json(call.input) }}</pre>
                <div class="tool__label">{{ call.ok ? 'Resultado' : 'Erro' }}</div>
                <pre class="tool__pre">{{ result(call) }}</pre>
              </details>
            }
          </details>
        } @empty {
          <p class="bo__empty">Sem turnos do agente nesta conversa.</p>
        }
      </section>
    }
  `,
})
export class BackofficePanel {
  protected readonly store = inject(BackofficeStore);
  protected readonly openEmail = signal<string | null>(null);

  protected readonly totals = computed(() =>
    this.store.turns().reduce(
      (t, turn) => ({
        tokens: t.tokens + turn.inputTokens + turn.outputTokens,
        cost: turn.costUsd === null ? t.cost : (t.cost ?? 0) + turn.costUsd,
      }),
      { tokens: 0, cost: null as number | null },
    ),
  );

  protected toggleEmail(id: string): void {
    this.openEmail.set(this.openEmail() === id ? null : id);
  }

  protected statusLabel(s: keyof typeof STATUS_LABELS): string {
    return STATUS_LABELS[s] ?? s;
  }

  protected leadType(t: string): string {
    return LEAD_TYPES[t] ?? t;
  }

  protected emailKind(k: string): string {
    return EMAIL_KINDS[k] ?? k;
  }

  /** Known fields first, in FIELD_LABELS order (Postgres jsonb does not keep key order). */
  protected fields(lead: BackofficeLead): { key: string; label: string; value: string }[] {
    const rank = (k: string) => {
      const i = FIELD_ORDER.indexOf(k);
      return i === -1 ? FIELD_ORDER.length : i;
    };
    return Object.entries(lead.fields)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, v]) => ({
        key,
        label: FIELD_LABELS[key] ?? key.replace(/_/g, ' '),
        value: typeof v === 'string' ? v : JSON.stringify(v),
      }));
  }

  protected at(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : time.format(d);
  }

  protected cost(v: number | null): string {
    return v === null ? 'custo n/d' : usd.format(v);
  }

  protected num(n: number): string {
    return int.format(n);
  }

  protected json(v: unknown): string {
    return JSON.stringify(v, null, 2) ?? '';
  }

  protected result(call: BackofficeToolCall): string {
    const raw = call.ok ? call.output : call.error;
    if (!raw) return '—';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
}
