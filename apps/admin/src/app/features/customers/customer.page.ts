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
  customerRoleLabels,
  customerRoles,
  formatCents,
  leadStatusLabels,
  quoteStatusLabels,
  leadTypeLabel,
  profileFieldLabels,
  profileFields,
  type CustomerDetail,
  type CustomerProfileFieldView,
  type CustomerRole,
  type LeadStatus,
  type ProfileField,
} from '@wa/shared';
import {
  CustomersData,
  editorText,
  errorMessage,
  fieldEditors,
  formatPhone,
  parseEditor,
  profileText,
  shortDate,
} from './customers.data';

const conversationStatus: Record<string, string> = {
  bot: 'Assistente',
  human: 'Com a equipa',
  closed: 'Fechada',
};

interface Row {
  field: ProfileField;
  label: string;
  view: CustomerProfileFieldView | undefined;
}

/** One customer (WA-027): record, numbers, preferences, conversations, leads and notes. */
@Component({
  selector: 'app-customer-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <a class="btn btn--ghost btn--sm back" routerLink="..">← Clientes</a>
      @if (error()) {
        <p class="notice notice--error" role="alert">{{ error() }}</p>
      }
      @if (customer(); as c) {
        <header class="page__head">
          <div class="chead">
            <h1 class="page__title">{{ title() }}</h1>
            @if (c.role) {
              <span class="rtag">{{ roleLabels[c.role] }}</span>
            }
          </div>
          <p class="muted small m0">{{ c.company ? c.company + ' · ' : '' }}{{ phones() }}</p>
        </header>

        <div class="cgrid">
          <div class="stack">
            <section class="card" aria-labelledby="pref-title">
              <h2 class="card__title" id="pref-title">Preferências</h2>
              @switch (c.profile.state) {
                @case ('disabled') {
                  <p class="notice mt">
                    As preferências de clientes estão desligadas para esta empresa.
                  </p>
                }
                @case ('opted_out') {
                  <p class="notice mt">
                    O cliente opôs-se à personalização: não se guardam nem usam preferências. O
                    histórico mantém-se.
                  </p>
                }
                @default {
                  <p class="small muted mt">
                    O assistente regista só preferências de serviço, com as palavras do cliente. O
                    que a equipa altera ou bloqueia, o assistente não muda.
                  </p>
                  <ul class="plain prefs">
                    @for (r of rows(); track r.field) {
                      <li class="pref" [attr.data-field]="r.field">
                        <div class="pref__head">
                          <span class="pref__label">{{ r.label }}</span>
                          @if (r.view?.locked) {
                            <span class="ptag ptag--lock">Bloqueado</span>
                          }
                          @if (r.view && r.view.value !== null) {
                            <span class="ptag">{{
                              r.view.source === 'team' ? 'Equipa' : 'Assistente'
                            }}</span>
                          }
                        </div>
                        @if (editing() === r.field) {
                          <div class="pref__edit">
                            @switch (editor(r.field).kind) {
                              @case ('choice') {
                                <select
                                  class="input input--sm"
                                  [attr.aria-label]="r.label"
                                  (change)="draftValue.set($any($event.target).value)"
                                >
                                  @for (o of options(r.field); track o.value) {
                                    <option [value]="o.value" [selected]="o.value === draftValue()">
                                      {{ o.label }}
                                    </option>
                                  }
                                </select>
                              }
                              @case ('boolean') {
                                <select
                                  class="input input--sm"
                                  [attr.aria-label]="r.label"
                                  (change)="draftValue.set($any($event.target).value)"
                                >
                                  <option value="true" [selected]="draftValue() === 'true'">
                                    Sim
                                  </option>
                                  <option value="false" [selected]="draftValue() !== 'true'">
                                    Não
                                  </option>
                                </select>
                              }
                              @case ('products') {
                                <textarea
                                  class="input"
                                  rows="3"
                                  [attr.aria-label]="r.label"
                                  placeholder="Um por linha: produto; quantidade"
                                  [value]="draftValue()"
                                  (input)="draftValue.set($any($event.target).value)"
                                ></textarea>
                              }
                              @default {
                                <input
                                  class="input input--sm"
                                  [attr.aria-label]="r.label"
                                  placeholder="Separados por vírgulas"
                                  [value]="draftValue()"
                                  (input)="draftValue.set($any($event.target).value)"
                                />
                              }
                            }
                            <div class="row">
                              <button
                                type="button"
                                class="btn btn--primary btn--sm"
                                [disabled]="busy()"
                                (click)="saveField(r)"
                              >
                                Guardar
                              </button>
                              <button
                                type="button"
                                class="btn btn--ghost btn--sm"
                                (click)="editing.set(null)"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        } @else {
                          <div class="pref__value">{{ text(r.field, r.view?.value) }}</div>
                          @if (r.view?.evidence) {
                            <div class="small muted why">
                              Porquê: «{{ r.view!.evidence }}» · {{ date(r.view!.updatedAt) }}
                            </div>
                          } @else if (r.view?.updatedBy) {
                            <div class="small muted why">
                              {{ r.view!.updatedBy }} · {{ date(r.view!.updatedAt) }}
                            </div>
                          }
                          <div class="row">
                            <button type="button" class="btn btn--ghost btn--sm" (click)="edit(r)">
                              Editar
                            </button>
                            <button
                              type="button"
                              class="btn btn--ghost btn--sm"
                              [disabled]="busy()"
                              (click)="toggleLock(r)"
                            >
                              {{ r.view?.locked ? 'Desbloquear' : 'Bloquear' }}
                            </button>
                            @if (r.view && r.view.value !== null) {
                              <button
                                type="button"
                                class="btn btn--ghost btn--sm"
                                [disabled]="busy()"
                                (click)="removeField(r.field)"
                              >
                                Apagar
                              </button>
                            }
                          </div>
                        }
                      </li>
                    }
                  </ul>
                  @if (confirmClear()) {
                    <div class="notice confirm" role="alertdialog" aria-label="Apagar perfil">
                      <p class="m0">
                        Apaga as preferências de todos os números deste cliente e deixa de
                        personalizar as respostas. O histórico mantém-se. Fica registado.
                      </p>
                      <div class="row">
                        <button
                          type="button"
                          class="btn btn--danger btn--sm"
                          [disabled]="busy()"
                          (click)="clearProfile()"
                        >
                          Apagar perfil
                        </button>
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm"
                          (click)="confirmClear.set(false)"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  } @else {
                    <button type="button" class="btn btn--sm mt" (click)="confirmClear.set(true)">
                      Apagar perfil e parar a personalização
                    </button>
                  }
                }
              }
            </section>

            <section class="card">
              <h2 class="card__title">Pedidos, encomendas e orçamentos</h2>
              <ul class="plain list">
                @for (l of c.leads; track l.id) {
                  <li>
                    <a [routerLink]="['/leads', l.id]">{{ typeLabel(l.type) }}</a>
                    <span class="small muted">
                      · {{ status(l.status) }} · {{ date(l.createdAt) }}</span
                    >
                    @if (l.products || l.summary) {
                      <div class="small">{{ l.products || l.summary }}</div>
                    }
                  </li>
                }
                @for (q of c.quotes; track q.id) {
                  <li>
                    <a [routerLink]="['/quotes', q.id]">Orçamento {{ q.number }}</a>
                    <span class="small muted">
                      · {{ quoteStatus[q.status] }} · {{ date(q.sentAt ?? q.createdAt) }}</span
                    >
                    <div class="small">
                      {{ cents(q.totalCents) }} com IVA{{
                        q.branchName ? ' · ' + q.branchName : ''
                      }}
                    </div>
                  </li>
                }
                @if (!c.leads.length && !c.quotes.length) {
                  <li class="small muted">Sem pedidos.</li>
                }
              </ul>
            </section>

            <section class="card">
              <h2 class="card__title">Conversas</h2>
              <ul class="plain list">
                @for (v of c.conversations; track v.id) {
                  <li>
                    <a [routerLink]="['/inbox', v.id]">{{ date(v.lastActivityAt) }}</a>
                    <span class="small muted">
                      · {{ convStatus(v.status) }} · {{ v.messages }}
                      {{ v.messages === 1 ? 'mensagem' : 'mensagens' }}</span
                    >
                    @if (v.lastText) {
                      <div class="small last">{{ v.lastText }}</div>
                    }
                  </li>
                } @empty {
                  <li class="small muted">Sem conversas.</li>
                }
              </ul>
            </section>
          </div>

          <div class="stack">
            <section class="card">
              <h2 class="card__title">Ficha</h2>
              <form class="form" (submit)="saveRecord($event)">
                <label class="field">
                  <span class="field__label">Nome</span>
                  <input class="input" name="name" [value]="c.name ?? ''" />
                </label>
                <label class="field">
                  <span class="field__label">Empresa</span>
                  <input class="input" name="company" [value]="c.company ?? ''" />
                </label>
                <label class="field">
                  <span class="field__label">NIF</span>
                  <input class="input" name="nif" inputmode="numeric" [value]="c.nif ?? ''" />
                </label>
                <label class="field">
                  <span class="field__label">Tipo de cliente</span>
                  <select class="input" name="role">
                    <option value="" [selected]="!c.role">Por definir</option>
                    @for (r of roles; track r) {
                      <option [value]="r" [selected]="r === c.role">{{ roleLabels[r] }}</option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">Regiões</span>
                  <input
                    class="input"
                    name="regions"
                    placeholder="Separadas por vírgulas"
                    [value]="c.regions.join(', ')"
                  />
                </label>
                <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
                  Guardar ficha
                </button>
              </form>
            </section>

            <section class="card">
              <h2 class="card__title">Números de WhatsApp</h2>
              <ul class="plain list">
                @for (n of c.contacts; track n.id) {
                  <li class="num">
                    <span>
                      <a [href]="'https://wa.me/' + n.phone" target="_blank" rel="noopener">{{
                        phone(n.phone)
                      }}</a>
                      @if (n.name) {
                        <span class="small muted"> · {{ n.name }}</span>
                      }
                    </span>
                    @if (c.contacts.length > 1) {
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        [disabled]="busy()"
                        (click)="unlink(n.id)"
                      >
                        Separar
                      </button>
                    }
                  </li>
                }
              </ul>
              <form class="addnum" (submit)="link($event)">
                <input
                  class="input input--sm"
                  name="phone"
                  inputmode="tel"
                  placeholder="351912345678"
                  aria-label="Outro número do cliente"
                  [value]="newPhone()"
                  (input)="newPhone.set($any($event.target).value)"
                />
                <button type="submit" class="btn btn--sm" [disabled]="busy() || !newPhone().trim()">
                  Associar número
                </button>
              </form>
            </section>

            <section class="card">
              <h2 class="card__title">Notas</h2>
              <form class="form" (submit)="addNote($event)">
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
              <ul class="plain list">
                @for (n of c.notes; track n.id) {
                  <li>
                    <p class="note">{{ n.body }}</p>
                    <div class="small muted">
                      {{ n.author ? n.author.name || n.author.email : 'Equipa' }} ·
                      {{ date(n.createdAt) }}
                    </div>
                  </li>
                } @empty {
                  <li class="small muted">Ainda sem notas.</li>
                }
              </ul>
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
    .chead {
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
    .rtag,
    .ptag {
      font-size: 11px;
      font-weight: 600;
      color: #20403a;
      background: var(--teal-soft);
      border-radius: 9px;
      padding: 1px 7px;
    }
    .ptag--lock {
      color: #8a4b08;
      background: #fdebd3;
    }
    .cgrid {
      display: grid;
      gap: 16px;
    }
    .plain {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .list li,
    .pref {
      padding: 10px 0;
      border-top: 1px solid #e9edef;
      overflow-wrap: anywhere;
    }
    .list {
      margin-top: 8px;
      font-size: 14px;
    }
    .prefs {
      margin-top: 8px;
    }
    .pref__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .pref__label {
      font-size: 13px;
      color: var(--muted);
    }
    .pref__value {
      margin: 2px 0;
      font-weight: 600;
    }
    .pref__edit {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 6px;
    }
    .why {
      margin-bottom: 4px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: -10px;
    }
    .pref__edit .row,
    .confirm .row {
      margin-left: 0;
    }
    .confirm {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }
    .form {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      margin-top: 8px;
    }
    .form .btn {
      align-self: flex-start;
      margin-top: 8px;
    }
    .num .btn {
      flex-shrink: 0;
      white-space: nowrap;
    }
    .num {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .addnum {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .addnum .input {
      flex: 1 1 160px;
      min-width: 0;
    }
    .note {
      margin: 0 0 2px;
      white-space: pre-line;
    }
    .last {
      color: #3b4a54;
    }
    @media (min-width: 900px) {
      .cgrid {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        align-items: start;
      }
    }
  `,
})
export class CustomerPage {
  private readonly data = inject(CustomersData);

  /** The route's `:id`. */
  readonly id = input.required<string>();

  protected readonly roles = customerRoles;
  protected readonly roleLabels = customerRoleLabels;
  protected readonly customer = signal<CustomerDetail | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly newPhone = signal('');
  protected readonly editing = signal<ProfileField | null>(null);
  protected readonly draftValue = signal('');
  protected readonly confirmClear = signal(false);

  protected readonly title = computed(() => {
    const c = this.customer();
    if (!c) return '';
    return (
      c.name || c.contacts.find((n) => n.name)?.name || formatPhone(c.contacts[0]?.phone ?? '')
    );
  });
  protected readonly phones = computed(() =>
    (this.customer()?.contacts ?? []).map((n) => formatPhone(n.phone)).join(', '),
  );
  protected readonly rows = computed<Row[]>(() => {
    const fields = this.customer()?.profile.fields ?? [];
    return profileFields.map((field) => ({
      field,
      label: profileFieldLabels[field],
      view: fields.find((f) => f.field === field),
    }));
  });

  constructor() {
    effect(() => {
      const id = this.id();
      void this.run(async () => this.customer.set(await this.data.detail(id)));
    });
  }

  protected phone = formatPhone;
  protected date = shortDate;
  protected text = profileText;
  protected typeLabel = leadTypeLabel;
  protected quoteStatus = quoteStatusLabels;
  protected cents = formatCents;
  protected status = (s: string) => leadStatusLabels[s as LeadStatus] ?? s;
  protected convStatus = (s: string) => conversationStatus[s] ?? s;
  protected editor = (f: ProfileField) => fieldEditors[f];
  protected options = (f: ProfileField) => {
    const e = fieldEditors[f];
    return e.kind === 'choice' ? e.options : [];
  };

  protected edit(r: Row): void {
    const e = fieldEditors[r.field];
    const current = editorText(r.field, r.view?.value);
    this.draftValue.set(
      current || (e.kind === 'choice' ? e.options[0]!.value : e.kind === 'boolean' ? 'false' : ''),
    );
    this.editing.set(r.field);
  }

  protected saveField(r: Row): Promise<void> {
    const value = parseEditor(r.field, this.draftValue(), r.view?.value);
    return this.run(async () => {
      this.customer.set(await this.data.setField(this.id(), r.field, { value }));
      this.editing.set(null);
    });
  }

  protected toggleLock(r: Row): Promise<void> {
    return this.run(async () =>
      this.customer.set(await this.data.setField(this.id(), r.field, { locked: !r.view?.locked })),
    );
  }

  protected removeField(field: ProfileField): Promise<void> {
    return this.run(async () => this.customer.set(await this.data.removeField(this.id(), field)));
  }

  protected clearProfile(): Promise<void> {
    return this.run(async () => {
      this.customer.set(await this.data.clearProfile(this.id()));
      this.confirmClear.set(false);
    });
  }

  protected saveRecord(event: Event): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const get = (k: string) => String(form.get(k) ?? '');
    return this.run(async () =>
      this.customer.set(
        await this.data.update(this.id(), {
          name: get('name'),
          company: get('company'),
          nif: get('nif'),
          role: (get('role') || null) as CustomerRole | null,
          regions: get('regions')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      ),
    );
  }

  protected link(event: Event): Promise<void> {
    event.preventDefault();
    return this.run(async () => {
      this.customer.set(await this.data.linkPhone(this.id(), this.newPhone()));
      this.newPhone.set('');
    });
  }

  protected unlink(contactId: string): Promise<void> {
    return this.run(async () => this.customer.set(await this.data.unlink(this.id(), contactId)));
  }

  protected addNote(event: Event): Promise<void> {
    event.preventDefault();
    const body = this.draft().trim();
    if (!body) return Promise.resolve();
    return this.run(async () => {
      this.customer.set(await this.data.addNote(this.id(), body));
      this.draft.set('');
    });
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
