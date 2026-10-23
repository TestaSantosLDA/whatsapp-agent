import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import type { AdminSettingsView } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import {
  buildSettingsForm,
  formToSettings,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type SettingsForm,
} from './settings.form';

/** Settings (admins, WA-022): what the agent promises and who receives each branch's leads. */
@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error() && !form()) {
      <div class="card notice notice--error" role="alert">{{ error() }}</div>
    }
    @if (form(); as f) {
      <form [formGroup]="f" (ngSubmit)="save()" class="stack">
        <section class="card">
          <h2 class="card__title">Atendimento</h2>
          <div class="field">
            <label class="field__label" for="rt">
              Tempo de resposta prometido ao cliente
              @if (isOverridden('response_time')) {
                <span class="tag">alterado</span>
              }
            </label>
            <input id="rt" class="input" formControlName="response_time" />
            <p class="field__hint">
              O assistente diz “a equipa contacta-o em …”. Ex.: um dia útil.
            </p>
          </div>
          <div class="field field--narrow">
            <label class="field__label" for="rth">
              Alerta de pedido sem resposta (horas úteis)
              @if (isOverridden('response_time_hours')) {
                <span class="tag">alterado</span>
              }
            </label>
            <input
              id="rth"
              class="input"
              type="number"
              min="0.5"
              max="200"
              step="0.5"
              inputmode="decimal"
              formControlName="response_time_hours"
              placeholder="8"
            />
          </div>
          <div class="field">
            <label class="field__label" for="ht">
              Passar a uma pessoa também quando…
              @if (isOverridden('handoff_triggers')) {
                <span class="tag">alterado</span>
              }
            </label>
            <textarea
              id="ht"
              class="input"
              rows="4"
              formControlName="handoff_triggers"
              placeholder="Uma situação por linha"
            ></textarea>
            <p class="field__hint">
              Além dos casos de sempre (o cliente pede uma pessoa, reclamações, falta de
              informação).
            </p>
          </div>
        </section>

        <div formArrayName="branches" class="stack branches-grid">
          @for (
            branch of f.controls.branches.controls;
            track branch.controls.id.value;
            let i = $index
          ) {
            <section class="card" [formGroupName]="i">
              <h2 class="card__title">{{ branchName(branch.controls.id.value) }}</h2>
              <div class="field">
                <label class="field__label" [for]="'le-' + i">
                  Quem recebe os pedidos e passagens a pessoa
                  @if (isOverridden('branches.' + branch.controls.id.value + '.lead_emails')) {
                    <span class="tag">alterado</span>
                  }
                </label>
                <textarea
                  class="input"
                  rows="2"
                  [id]="'le-' + i"
                  formControlName="lead_emails"
                  placeholder="Um email por linha"
                ></textarea>
                @if (branch.controls.lead_emails.errors?.['emails']; as bad) {
                  <p class="field__error">Email inválido: {{ bad.join(', ') }}</p>
                }
              </div>
              <fieldset class="hours" formGroupName="hours">
                <legend class="field__label">
                  Horário
                  @if (isOverridden('branches.' + branch.controls.id.value + '.hours')) {
                    <span class="tag">alterado</span>
                  }
                </legend>
                @for (day of weekdays; track day) {
                  <label class="hours__row">
                    <span class="hours__day">{{ labels[day] }}</span>
                    <input
                      class="input"
                      [formControlName]="day"
                      placeholder="Fechado"
                      [class.input--invalid]="branch.controls.hours.controls[day].invalid"
                    />
                  </label>
                }
                <p class="field__hint">Ex.: 09:00-13:00, 14:00-18:00. Vazio = fechado.</p>
              </fieldset>
            </section>
          }
        </div>

        <div class="actions">
          @if (status(); as s) {
            <p class="actions__status" role="status">{{ s }}</p>
          }
          @if (error()) {
            <p class="actions__status actions__status--error" role="alert">{{ error() }}</p>
          }
          @if (view()?.overridden?.length) {
            <button type="button" class="btn" [disabled]="saving()" (click)="reset()">
              Repor valores do ficheiro
            </button>
          }
          <button type="submit" class="btn btn--primary" [disabled]="saving() || f.invalid">
            {{ saving() ? 'A guardar…' : 'Guardar' }}
          </button>
        </div>
      </form>
    } @else if (!error()) {
      <p class="muted">A carregar…</p>
    }
  `,
})
export class SettingsPage {
  private readonly api = inject(AdminApi);

  protected readonly weekdays = WEEKDAYS;
  protected readonly labels = WEEKDAY_LABELS;
  protected readonly view = signal<AdminSettingsView | null>(null);
  protected readonly form = signal<SettingsForm | null>(null);
  protected readonly saving = signal(false);
  protected readonly status = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly overridden = computed(() => new Set(this.view()?.overridden ?? []));

  constructor() {
    void this.load();
  }

  protected isOverridden(path: string): boolean {
    return this.overridden().has(path);
  }

  protected branchName(id: string): string {
    return this.view()?.branches.find((b) => b.id === id)?.name ?? id;
  }

  private async load(): Promise<void> {
    try {
      this.show(await this.api.client<AdminSettingsView>('GET', '/settings'));
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async save(): Promise<void> {
    const f = this.form();
    if (!f || f.invalid) return;
    await this.run(async () => {
      const view = await this.api.client<AdminSettingsView>('PUT', '/settings', formToSettings(f));
      this.show(view);
      this.status.set('Guardado. Aplica-se à próxima conversa e ao próximo pedido.');
    });
  }

  protected async reset(): Promise<void> {
    if (!confirm('Repor as definições do ficheiro de configuração para todas as filiais?')) return;
    await this.run(async () => {
      this.show(await this.api.client<AdminSettingsView>('DELETE', '/settings'));
      this.status.set('Valores do ficheiro repostos.');
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.saving.set(true);
    this.status.set(null);
    this.error.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.saving.set(false);
    }
  }

  private show(view: AdminSettingsView): void {
    this.view.set(view);
    this.form.set(buildSettingsForm(view.settings));
  }
}

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.';
}
