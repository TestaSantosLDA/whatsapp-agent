import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ChatStore } from './core/chat.store';

@Component({
  selector: 'app-access-gate',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="gate" (submit)="$event.preventDefault(); submit(code.value)">
      <h1 class="gate__title">Chat simulator</h1>
      <p class="gate__text">Enter the access code to open the demo.</p>
      <input
        #code
        class="input gate__input"
        type="password"
        autocomplete="current-password"
        placeholder="Access code"
        aria-label="Access code"
        autofocus
      />
      @if (store.gateError(); as err) {
        <p class="gate__error" role="alert">{{ err }}</p>
      }
      <button type="submit" class="btn btn--primary" [disabled]="busy()">Enter</button>
    </form>
  `,
})
export class AccessGate {
  protected readonly store = inject(ChatStore);
  protected readonly busy = signal(false);

  protected async submit(code: string): Promise<void> {
    if (!code.trim()) return;
    this.busy.set(true);
    try {
      await this.store.submitAccessCode(code);
    } finally {
      this.busy.set(false);
    }
  }
}
