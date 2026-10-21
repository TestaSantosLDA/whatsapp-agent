import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ChatStore, InteractiveReply } from '../core/chat.store';
import { ListSheet } from './list-sheet';
import { MessageBubble } from './message-bubble';
import type { ListInteractive } from './message-view';

@Component({
  selector: 'app-chat-phone',
  imports: [MessageBubble, ListSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="phone">
      <header class="chat-head">
        <div class="avatar" aria-hidden="true">{{ initials() }}</div>
        <div class="chat-head__info">
          <div class="chat-head__name">{{ store.client()?.name ?? 'Simulador' }}</div>
          <div class="chat-head__status">{{ statusLine() }}</div>
        </div>
      </header>

      <div class="chat-body" #scroller>
        <div class="chat-notice">
          Conversa simulada. As mensagens não são enviadas por nenhuma rede real.
        </div>
        @for (m of store.messages(); track m.id) {
          <app-message-bubble
            [message]="m"
            (reply)="send($event)"
            (openList)="openList.set($event)"
          />
        }
        @if (store.typing()) {
          <div class="msg-row">
            <div class="bubble bubble--out typing-bubble" aria-label="a escrever">
              <span></span><span></span><span></span>
            </div>
          </div>
        }
      </div>

      @if (store.error(); as err) {
        <div class="chat-error" role="alert">
          {{ err }}
          <button
            type="button"
            class="chat-error__close"
            aria-label="Fechar"
            (click)="store.error.set(null)"
          >
            ×
          </button>
        </div>
      }

      <form class="chat-input" (submit)="$event.preventDefault(); submit()">
        <input
          #box
          type="text"
          class="chat-input__field"
          placeholder="Mensagem"
          autocomplete="off"
          enterkeyhint="send"
          [value]="draft()"
          (input)="draft.set(box.value)"
          [disabled]="!store.clientId()"
        />
        <button
          type="submit"
          class="send-btn"
          aria-label="Enviar"
          [disabled]="!draft().trim() || store.sending()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2l12.6 1.8-12.6 1.8z" />
          </svg>
        </button>
      </form>

      @if (openList(); as list) {
        <app-list-sheet
          [list]="list"
          (picked)="openList.set(null); send($event)"
          (closed)="openList.set(null)"
        />
      }
    </div>
  `,
})
export class ChatPhone {
  protected readonly store = inject(ChatStore);
  protected readonly draft = signal('');
  protected readonly openList = signal<ListInteractive | null>(null);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  protected readonly initials = computed(() => {
    const name = this.store.client()?.name ?? 'S';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
  });

  protected readonly statusLine = computed(() => {
    if (this.store.typing()) return 'a escrever…';
    switch (this.store.connection()) {
      case 'open':
        return 'online';
      case 'connecting':
        return 'a ligar…';
      case 'retrying':
        return 'sem ligação, a tentar de novo…';
      default:
        return '';
    }
  });

  constructor() {
    afterRenderEffect(() => {
      this.store.messages();
      this.store.typing();
      const el = this.scroller().nativeElement;
      el.scrollTop = el.scrollHeight;
    });
  }

  protected async submit(): Promise<void> {
    const text = this.draft();
    if (!text.trim()) return;
    this.draft.set('');
    const ok = await this.store.sendText(text);
    if (!ok) this.draft.set(text);
  }

  protected send(reply: InteractiveReply): void {
    void this.store.sendReply(reply);
  }
}
