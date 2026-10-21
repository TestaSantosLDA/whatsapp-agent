import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ChatStore } from './core/chat.store';
import { CUSTOM_PERSONA_ID, isValidPhone, PERSONAS } from './core/personas';

@Component({
  selector: 'app-top-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="topbar">
      <div class="topbar__brand">Chat simulator</div>

      <label class="field">
        <span class="field__label">Client</span>
        <select #client (change)="store.selectClient(client.value)">
          @for (c of store.clients(); track c.id) {
            <option [value]="c.id" [selected]="c.id === store.clientId()">{{ c.name }}</option>
          }
        </select>
      </label>

      <label class="field">
        <span class="field__label">Persona</span>
        <select #persona (change)="pickPersona(persona.value)">
          @for (p of personas; track p.id) {
            <option [value]="p.id" [selected]="p.id === personaId()">
              {{ p.name }} · {{ p.lang }}{{ p.note ? ' · ' + p.note : '' }}
            </option>
          }
          <option [value]="customId" [selected]="personaId() === customId">Custom…</option>
        </select>
      </label>

      @if (showCustom()) {
        <form
          class="topbar__custom"
          (submit)="$event.preventDefault(); applyCustom(cname.value, cphone.value)"
        >
          <input
            #cname
            class="input"
            placeholder="Name"
            [value]="store.persona().name"
            aria-label="Custom name"
          />
          <input
            #cphone
            class="input"
            placeholder="Phone (digits)"
            inputmode="numeric"
            [value]="store.persona().phone"
            aria-label="Custom phone"
          />
          <button type="submit" class="btn">Use</button>
          @if (customError()) {
            <span class="topbar__err">{{ customError() }}</span>
          }
        </form>
      }

      <span class="topbar__phone">+{{ store.persona().phone }}</span>

      <div class="topbar__actions">
        <button
          type="button"
          class="btn btn--danger"
          [disabled]="!store.clientId()"
          (click)="store.reset()"
        >
          Reset
        </button>
        <button
          type="button"
          class="btn panel-toggle"
          [attr.aria-pressed]="panelOpen()"
          (click)="togglePanel.emit()"
        >
          Back-office
        </button>
      </div>
    </div>
  `,
})
export class TopBar {
  protected readonly store = inject(ChatStore);
  protected readonly personas = PERSONAS;
  protected readonly customId = CUSTOM_PERSONA_ID;
  readonly togglePanel = output<void>();
  readonly panelOpen = input(false);

  private readonly customPicked = signal(false);
  protected readonly customError = signal<string | null>(null);

  protected readonly personaId = computed(() => {
    if (this.customPicked()) return CUSTOM_PERSONA_ID;
    const p = this.store.persona();
    return PERSONAS.some((x) => x.id === p.id) ? p.id : CUSTOM_PERSONA_ID;
  });
  protected readonly showCustom = computed(() => this.personaId() === CUSTOM_PERSONA_ID);

  protected pickPersona(id: string): void {
    this.customError.set(null);
    const preset = PERSONAS.find((p) => p.id === id);
    if (preset) {
      this.customPicked.set(false);
      this.store.selectPersona(preset);
    } else {
      this.customPicked.set(true);
    }
  }

  protected applyCustom(name: string, phone: string): void {
    const digits = phone.replace(/\D/g, '');
    if (!name.trim()) return this.customError.set('Name required');
    if (!isValidPhone(digits)) return this.customError.set('6 to 15 digits');
    this.customError.set(null);
    this.store.selectPersona({
      id: CUSTOM_PERSONA_ID,
      name: name.trim(),
      phone: digits,
      lang: 'custom',
    });
  }
}
