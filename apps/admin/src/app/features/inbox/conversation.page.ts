import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type OnDestroy,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  customerRoleLabels,
  profileFieldLabels,
  type BackofficeLead,
  type CustomerDetail,
} from '@wa/shared';
import { CustomersData, profileText } from '../customers/customers.data';
import { contactLabel, formatPhone, fullWhen, LEAD_TYPES, STATUS_LABELS, timeOf } from './format';
import { InboxStore } from './inbox.store';
import { toInboxMessageView } from './message-view';

const FIELD_LABELS: Record<string, string> = {
  summary: 'Resumo',
  reason: 'Motivo',
  urgency: 'Urgência',
  name: 'Nome',
  location: 'Localidade',
  area: 'Área',
  quantity: 'Quantidade',
  product: 'Produto',
  products: 'Produtos',
  notes: 'Notas',
};

/** One conversation: transcript, takeover, reply as a person, return to bot, assignment. */
@Component({
  selector: 'app-conversation-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let d = store.detail();
    @let c = d?.conversation;
    <article class="thread">
      <header class="thread__head">
        <a
          class="btn btn--ghost btn--sm thread__back"
          routerLink=".."
          aria-label="Voltar às conversas"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </a>
        <div class="thread__who">
          @if (c) {
            <h2 class="thread__name">{{ label(c.contact) }}</h2>
            <div class="muted small">
              {{ phone(c.contact.phone) }}{{ c.branchName ? ' · ' + c.branchName : '' }}
            </div>
          } @else {
            <h2 class="thread__name">Conversa</h2>
          }
        </div>
        @if (c) {
          <span class="conv-status conv-status--{{ c.status }}">{{ statusLabel[c.status] }}</span>
        }
      </header>

      @if (c && c.status !== 'closed') {
        <div class="thread__bar">
          @if (c.status === 'human') {
            <button
              type="button"
              class="btn btn--sm"
              [disabled]="store.busy()"
              (click)="store.returnToBot()"
            >
              Devolver ao assistente
            </button>
          } @else {
            <button
              type="button"
              class="btn btn--sm btn--primary"
              [disabled]="store.busy()"
              (click)="store.takeOver()"
            >
              Assumir conversa
            </button>
          }
          <label class="thread__assign">
            <span class="muted small">Atribuída a</span>
            <select
              class="input input--sm"
              aria-label="Atribuir a"
              [disabled]="store.busy()"
              (change)="assign($any($event.target).value)"
            >
              <option value="" [selected]="!c.assignedTo">Ninguém</option>
              @for (m of d!.assignable; track m.id) {
                <option [value]="m.id" [selected]="m.id === c.assignedTo?.id">
                  {{ m.id === store.memberId() ? 'Eu' : m.name || m.email }}
                </option>
              }
            </select>
          </label>
        </div>
      }

      @if (store.detailError()) {
        <p class="notice notice--error thread__error" role="alert">{{ store.detailError() }}</p>
      }

      <div class="thread__body" #scroller>
        @if (d) {
          @if (customer(); as r) {
            <details class="lead-card customer-card" [open]="profile().length > 0">
              <summary>
                <span class="lead-card__type">Cliente</span>
                <span class="small">{{ recordLine(r) }}</span>
                <a class="small" [routerLink]="['/customers', r.id]">Ver ficha</a>
              </summary>
              @if (profile().length) {
                <dl class="lead-card__fields">
                  @for (p of profile(); track p[0]) {
                    <dt>{{ p[0] }}</dt>
                    <dd>{{ p[1] }}</dd>
                  }
                </dl>
              } @else if (r.profile.state === 'opted_out') {
                <p class="small muted customer-card__note">O cliente opôs-se à personalização.</p>
              }
            </details>
          }
          @for (lead of d.leads; track lead.id) {
            <details class="lead-card">
              <summary>
                <span class="lead-card__type">{{ leadType(lead) }}</span>
                <span class="muted small">{{ when(lead.createdAt) }}</span>
              </summary>
              <dl class="lead-card__fields">
                @for (f of fields(lead); track f[0]) {
                  <dt>{{ f[0] }}</dt>
                  <dd>{{ f[1] }}</dd>
                }
              </dl>
            </details>
          }
          <ol class="msgs">
            @for (m of messages(); track m.id) {
              <li class="msg" [class.msg--in]="m.side === 'in'" [class.msg--member]="m.byMember">
                <div class="msg__bubble" [attr.data-kind]="m.kind">
                  @if (m.author) {
                    <div class="msg__author">{{ m.author }}</div>
                  }
                  @if (m.imageUrl) {
                    <a class="msg__image" [href]="m.imageUrl" target="_blank" rel="noopener">
                      <img [src]="m.imageUrl" alt="Imagem enviada" loading="lazy" />
                    </a>
                  }
                  @if (m.documentUrl) {
                    <a class="msg__doc" [href]="m.documentUrl" target="_blank" rel="noopener">
                      <span class="msg__doc-icon" aria-hidden="true">{{ m.fileType }}</span>
                      <span class="msg__doc-name">{{ m.fileName }}</span>
                    </a>
                  }
                  @if (m.kind === 'tap') {
                    <div class="msg__tap">Tocou em «{{ m.text }}»</div>
                  } @else if (m.kind === 'media') {
                    <div class="msg__tap">Enviou uma imagem</div>
                  }
                  @if (m.header) {
                    <div class="msg__header">{{ m.header }}</div>
                  }
                  @if (m.text && m.kind !== 'tap') {
                    <div class="msg__text">{{ m.text }}</div>
                  }
                  @if (m.footer) {
                    <div class="msg__footer">{{ m.footer }}</div>
                  }
                  @if (m.options?.length) {
                    <ul class="msg__options" [attr.aria-label]="m.listButton ?? 'Botões'">
                      @for (o of m.options; track o.id) {
                        <li>{{ o.title }}</li>
                      }
                    </ul>
                  }
                  <span class="msg__time">{{ time(m.at) }}</span>
                </div>
              </li>
            } @empty {
              <li class="muted small center">Sem mensagens.</li>
            }
          </ol>
        } @else if (!store.detailError()) {
          <p class="muted center">A carregar…</p>
        }
      </div>

      @if (c && c.status !== 'closed') {
        <form class="composer" (submit)="send($event)">
          @if (c.status !== 'human') {
            <p class="composer__hint muted small">
              Ao responder, assume a conversa e o assistente deixa de responder.
            </p>
          }
          <div class="composer__row">
            <textarea
              class="input composer__input"
              rows="1"
              aria-label="Mensagem"
              placeholder="Escreva uma mensagem"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="enter($any($event))"
            ></textarea>
            <button
              type="submit"
              class="btn btn--primary composer__send"
              [disabled]="!draft().trim() || store.busy()"
              aria-label="Enviar"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2-7-8-1z" />
              </svg>
            </button>
          </div>
        </form>
      } @else if (c) {
        <p class="composer composer__hint muted small">
          Esta conversa terminou. Se o cliente voltar a escrever, abre-se uma nova.
        </p>
      }
    </article>
  `,
})
export class ConversationPage implements OnDestroy {
  protected readonly store = inject(InboxStore);
  /** Route parameter. */
  readonly id = input.required<string>();

  protected readonly draft = signal('');
  private readonly customers = inject(CustomersData);
  /** The customer's record and profile (WA-027), when the member may see it. */
  protected readonly customer = signal<CustomerDetail | null>(null);
  private readonly contactId = computed(() => this.store.detail()?.conversation.contact.id ?? null);
  protected readonly profile = computed<[string, string][]>(() =>
    (this.customer()?.profile.fields ?? [])
      .filter((f) => f.value !== null)
      .map((f) => [profileFieldLabels[f.field], profileText(f.field, f.value)]),
  );
  protected readonly statusLabel = STATUS_LABELS;
  protected readonly label = contactLabel;
  protected readonly phone = formatPhone;
  protected readonly time = timeOf;
  protected readonly when = fullWhen;
  protected readonly messages = computed(() =>
    (this.store.detail()?.messages ?? []).map(toInboxMessageView),
  );
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.draft.set('');
        void this.store.open(id);
      });
    });
    effect(() => {
      const contactId = this.contactId();
      untracked(() => void this.loadCustomer(contactId));
    });
    // Keep the newest message in view.
    afterRenderEffect(() => {
      this.messages();
      const el = this.scroller()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  ngOnDestroy(): void {
    this.store.close();
  }

  private async loadCustomer(contactId: string | null): Promise<void> {
    this.customer.set(null);
    if (!contactId) return;
    try {
      const record = await this.customers.byContact(contactId);
      // The member may have moved on to another conversation meanwhile.
      if (this.contactId() === contactId) this.customer.set(record);
    } catch {
      // Not visible to this member (no lead on their branches) or unavailable: no card.
    }
  }

  protected recordLine(r: CustomerDetail): string {
    return [r.name, r.company, r.role && customerRoleLabels[r.role]].filter(Boolean).join(' · ');
  }

  protected leadType(lead: BackofficeLead): string {
    return LEAD_TYPES[lead.type] ?? lead.type;
  }

  protected fields(lead: BackofficeLead): [string, string][] {
    return Object.entries(lead.fields)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => [FIELD_LABELS[k] ?? k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }

  protected assign(memberId: string): void {
    void this.store.assign(memberId || null);
  }

  /** Enter sends on a computer (Shift+Enter: new line); on a phone it is a new line. */
  protected enter(event: KeyboardEvent): void {
    if (event.shiftKey || event.isComposing) return;
    if (typeof matchMedia === 'function' && !matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    void this.submit();
  }

  protected send(event: Event): void {
    event.preventDefault();
    void this.submit();
  }

  private async submit(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.store.busy()) return;
    if (await this.store.reply(text)) this.draft.set('');
  }
}
