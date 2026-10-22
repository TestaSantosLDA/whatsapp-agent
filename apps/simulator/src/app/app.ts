import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { AccessGate } from './access-gate';
import { ChatPhone } from './chat/chat-phone';
import { ChatStore } from './core/chat.store';
import { TopBar } from './top-bar';

@Component({
  selector: 'app-root',
  imports: [AccessGate, ChatPhone, TopBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (store.phase()) {
      @case ('loading') {
        <div class="center-msg">A carregar…</div>
      }
      @case ('gate') {
        <app-access-gate />
      }
      @case ('error') {
        <div class="center-msg">
          <p>Could not reach the simulator API.</p>
          <p class="muted">{{ store.error() }}</p>
          <button type="button" class="btn btn--primary" (click)="store.init()">Retry</button>
        </div>
      }
      @case ('ready') {
        <div class="layout" [class.layout--panel-open]="panelOpen()">
          <app-top-bar
            class="layout__top"
            [panelOpen]="panelOpen()"
            (togglePanel)="panelOpen.set(!panelOpen())"
          />
          <main class="layout__chat">
            <app-chat-phone />
          </main>
          <aside class="layout__panel panel" aria-labelledby="panel-title">
            <h2 id="panel-title" class="panel__title">Back-office</h2>
            <p class="panel__text">Leads, emails and handoffs appear here (WA-018)</p>
            @if (store.conversationStatus(); as s) {
              <p class="panel__meta">
                Conversation status: <strong>{{ s }}</strong>
              </p>
            }
          </aside>
        </div>
      }
    }
  `,
})
export class App {
  protected readonly store = inject(ChatStore);
  protected readonly panelOpen = signal(false);

  constructor() {
    void this.store.init();
    inject(DestroyRef).onDestroy(() => this.store.disconnect());
  }
}
