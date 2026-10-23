import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  leadStatuses,
  leadStatusLabels,
  leadTypeLabel,
  lostReasonLabels,
  type AdminLeadDetail,
  type AdminLeadEvent,
  type LeadStatus,
  type LostReason,
} from '@wa/shared';
import {
  errorMessage,
  LeadsData,
  personName,
  shortBranch,
  shortDate,
  waitingLabel,
  type StatusChange,
} from './leads.data';
import { StatusBadge, StatusChips } from './status-chips';

/** Fields shown in their own places (or not useful to the team), left out of "Dados". */
const HIDDEN_FIELDS = new Set([
  'attachments',
  'summary',
  'request_type',
  'items',
  'name',
  'phone',
  'products',
]);

const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  location: 'Localidade',
  area: 'Área',
  products: 'Produtos',
  business_line: 'Linha de negócio',
  quantity: 'Quantidade',
  delivery: 'Entrega',
  company: 'Empresa',
  nif: 'NIF',
  reason: 'Motivo',
  notes: 'Notas',
  total: 'Total',
  checkout_url: 'Link de compra',
};

const RULE_LABELS: Record<string, string> = {
  round_robin: 'por rotação entre os comerciais da filial',
  branch_admin: 'administrador da filial (sem comerciais)',
  none: 'sem ninguém na filial',
};

const attachmentLabels: Record<string, string> = {
  image: 'Imagem',
  document: 'Documento',
  audio: 'Áudio',
  video: 'Vídeo',
};

/** One lead (WA-024): what the customer asked for, status, owner, notes and history. */
@Component({
  selector: 'app-lead-page',
  imports: [RouterLink, StatusBadge, StatusChips],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <a class="btn btn--ghost btn--sm back" routerLink="..">← Pedidos</a>
      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }
      @if (lead(); as l) {
        <header class="page__head">
          <div class="lhead">
            <h1 class="page__title">{{ l.name || l.phone || 'Cliente' }}</h1>
            <app-status-badge [status]="l.status" />
          </div>
          <p class="muted small m0">
            {{ typeLabel(l.type) }} · {{ branch(l.branchName) }} · recebido
            {{ date(l.createdAt) }}
            @if (l.waitingHours) {
              ·
              <span [class.late]="l.overdue">
                {{ l.overdue ? 'sem resposta há' : 'há' }} {{ waiting(l.waitingHours) }} (prazo
                {{ l.responseTimeHours }} h)
              </span>
            }
          </p>
        </header>

        <div class="lgrid">
          <div class="stack">
            <section class="card">
              <h2 class="card__title">Estado</h2>
              <div class="mt">
                <app-status-chips
                  [options]="statuses"
                  [current]="l.status"
                  [disabled]="busy()"
                  (changed)="setStatus($event)"
                />
              </div>
              @if (l.status === 'lost' && l.lostReason) {
                <p class="small muted m0 mt">Motivo: {{ reason(l.lostReason) }}</p>
              }
              <label class="field">
                <span class="field__label">Responsável</span>
                <select
                  class="input"
                  [disabled]="busy()"
                  (change)="setOwner($any($event.target).value)"
                >
                  <option value="" [selected]="!l.owner">Sem responsável</option>
                  @for (o of ownerOptions(); track o.id) {
                    <option [value]="o.id" [selected]="o.id === l.owner?.id">
                      {{ o.name || o.email }}
                    </option>
                  }
                </select>
              </label>
            </section>

            <section class="card">
              <h2 class="card__title">Pedido</h2>
              @if (l.summary) {
                <p class="summary">{{ l.summary }}</p>
              }
              <dl class="facts">
                @if (l.phone) {
                  <dt>Telefone</dt>
                  <dd>
                    <a [href]="'tel:' + l.phone">{{ l.phone }}</a>
                    @if (whatsapp(); as wa) {
                      · <a [href]="wa" target="_blank" rel="noopener">WhatsApp</a>
                    }
                  </dd>
                }
                @if (l.products) {
                  <dt>Produtos</dt>
                  <dd>{{ l.products }}</dd>
                }
                @for (f of facts(); track f.key) {
                  <dt>{{ f.label }}</dt>
                  <dd>{{ f.value }}</dd>
                }
              </dl>
              @if (l.attachments.length) {
                <h3 class="sub">Anexos</h3>
                <ul class="plain">
                  @for (a of l.attachments; track $index) {
                    <li>{{ attachment(a.type) }}{{ a.caption ? ': ' + a.caption : '' }}</li>
                  }
                </ul>
              }
              @if (l.conversationId) {
                <a class="btn btn--sm mt" [routerLink]="['/inbox', l.conversationId]">
                  Abrir a conversa
                </a>
              }
            </section>
          </div>

          <div class="stack">
            <section class="card">
              <h2 class="card__title">Notas</h2>
              <form class="note-form" (submit)="addNote($event)">
                <textarea
                  class="input"
                  rows="2"
                  placeholder="Escreva uma nota para a equipa"
                  aria-label="Nova nota"
                  [value]="draft()"
                  (input)="draft.set($any($event.target).value)"
                ></textarea>
                <button
                  type="submit"
                  class="btn btn--primary btn--sm"
                  [disabled]="busy() || !draft().trim()"
                >
                  Adicionar nota
                </button>
              </form>
              <ul class="plain notes">
                @for (n of notesNewestFirst(); track n.id) {
                  <li>
                    <p class="note__body">{{ n.body }}</p>
                    <div class="small muted">{{ person(n.author) }} · {{ date(n.createdAt) }}</div>
                  </li>
                } @empty {
                  <li class="small muted">Ainda sem notas.</li>
                }
              </ul>
            </section>

            <section class="card">
              <h2 class="card__title">Atividade</h2>
              <ol class="plain timeline">
                @for (e of l.events; track e.id) {
                  <li>
                    <div>{{ describe(e) }}</div>
                    <div class="small muted">
                      {{ e.actor ? person(e.actor) : 'Automático' }} · {{ date(e.createdAt) }}
                    </div>
                  </li>
                }
              </ol>
            </section>
          </div>
        </div>
      } @else if (!error()) {
        <p class="muted">A carregar…</p>
      }
    </section>
  `,
  styles: `
    .back {
      margin: 0 0 8px -10px;
    }
    .lhead {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
    }
    .m0 {
      margin: 0;
    }
    .mt {
      margin-top: 12px;
    }
    .late {
      color: var(--danger);
      font-weight: 600;
    }
    .lgrid {
      display: grid;
      gap: 16px;
    }
    .summary {
      margin: 10px 0 0;
      white-space: pre-line;
    }
    .facts {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 14px;
      margin: 12px 0 0;
      font-size: 14px;
    }
    .facts dt {
      color: var(--muted);
    }
    .facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .sub {
      font-size: 14px;
      margin: 14px 0 4px;
    }
    .plain {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .note-form {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      margin: 12px 0;
    }
    .notes li,
    .timeline li {
      padding: 8px 0;
      border-top: 1px solid #e9edef;
    }
    .note__body {
      margin: 0 0 2px;
      white-space: pre-line;
      overflow-wrap: anywhere;
    }
    .timeline {
      margin-top: 8px;
      font-size: 14px;
    }
    @media (min-width: 900px) {
      .lgrid {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        align-items: start;
      }
    }
  `,
})
export class LeadPage {
  private readonly data = inject(LeadsData);

  /** The route's `:id`. */
  readonly id = input.required<string>();

  protected readonly statuses = leadStatuses;
  protected readonly lead = signal<AdminLeadDetail | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly draft = signal('');

  protected readonly ownerOptions = computed(() => {
    const l = this.lead();
    if (!l) return [];
    const owners = l.owners;
    // Someone no longer on the branch stays visible as the current owner.
    return l.owner && !owners.some((o) => o.id === l.owner!.id) ? [l.owner, ...owners] : owners;
  });
  protected readonly notesNewestFirst = computed(() => [...(this.lead()?.notes ?? [])].reverse());
  protected readonly facts = computed(() => {
    const fields = this.lead()?.fields ?? {};
    return Object.entries(fields)
      .filter(([key, value]) => !HIDDEN_FIELDS.has(key) && shown(value))
      .map(([key, value]) => ({ key, label: FIELD_LABELS[key] ?? key, value: text(value) }));
  });
  protected readonly whatsapp = computed(() => {
    const digits = (this.lead()?.phone ?? '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}` : null;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      void this.run(async () => this.lead.set(await this.data.detail(id)));
    });
  }

  protected typeLabel = leadTypeLabel;
  protected date = shortDate;
  protected waiting = waitingLabel;
  protected person = personName;
  protected branch = shortBranch;
  protected reason = (r: LostReason) => lostReasonLabels[r];
  protected attachment = (type: string) => attachmentLabels[type] ?? type;

  protected setStatus(change: StatusChange): Promise<void> {
    return this.run(async () => this.lead.set(await this.data.setStatus(this.id(), change)));
  }

  protected setOwner(ownerId: string): Promise<void> {
    return this.run(async () =>
      this.lead.set(await this.data.setOwner(this.id(), ownerId || null)),
    );
  }

  protected async addNote(event: Event): Promise<void> {
    event.preventDefault();
    const body = this.draft().trim();
    if (!body) return;
    await this.run(async () => {
      await this.data.addNote(this.id(), body);
      this.draft.set('');
      this.lead.set(await this.data.detail(this.id()));
    });
  }

  protected describe(e: AdminLeadEvent): string {
    const d = e.data;
    const status = (s: unknown) => leadStatusLabels[s as LeadStatus] ?? String(s);
    switch (e.kind) {
      case 'created': {
        const owner = d['ownerName'] ? `, atribuído a ${String(d['ownerName'])}` : '';
        const rule = RULE_LABELS[String(d['rule'])];
        return `Pedido recebido pelo assistente${owner}${rule ? ` (${rule})` : ''}`;
      }
      case 'status': {
        const lost = d['lostReason'] ? `: ${lostReasonLabels[d['lostReason'] as LostReason]}` : '';
        return `Estado: ${status(d['from'])} → ${status(d['to'])}${lost}`;
      }
      case 'owner':
        return d['toName'] ? `Responsável: ${String(d['toName'])}` : 'Responsável removido';
      case 'note':
        return 'Nota adicionada';
      case 'reminder_owner':
        return `Lembrete enviado ao responsável (${hours(d['hours'])} h úteis sem resposta)`;
      case 'reminder_admin':
        return `Alerta enviado aos administradores (${hours(d['hours'])} h úteis sem resposta)`;
      default:
        return e.kind;
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

const shown = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);

function text(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const hours = (v: unknown) => String(Math.floor(Number(v) || 0));
