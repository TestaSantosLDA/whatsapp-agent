import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { SimChatMessage } from '@wa/shared';
import type { InteractiveReply } from '../core/chat.store';
import { WaFormatPipe, WaTimePipe } from '../core/wa-format.pipe';
import { ListInteractive, toMessageView } from './message-view';

@Component({
  selector: 'app-message-bubble',
  imports: [WaFormatPipe, WaTimePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'msg-row', '[class.msg-row--in]': "view().side === 'in'" },
  template: `
    @let v = view();
    <div
      class="bubble"
      [class.bubble--in]="v.side === 'in'"
      [class.bubble--out]="v.side === 'out'"
      [attr.data-kind]="v.kind"
    >
      @if (v.kind === 'image' && v.imageUrl) {
        <a class="bubble__image" [href]="v.imageUrl" target="_blank" rel="noopener noreferrer">
          <img [src]="v.imageUrl" alt="Imagem" loading="lazy" />
        </a>
      }
      @if (v.header) {
        <div class="bubble__header">{{ v.header }}</div>
      }
      @if (v.kind === 'unknown') {
        <pre class="bubble__raw">{{ v.text }}</pre>
      } @else if (v.text) {
        <div class="bubble__text" [innerHTML]="v.text | waFormat"></div>
      }
      @if (v.footer) {
        <div class="bubble__footer">{{ v.footer }}</div>
      }
      <span class="bubble__meta">
        <span class="bubble__time">{{ v.timestamp | waTime }}</span>
        @if (v.side === 'in') {
          @if (v.status === 'read') {
            <svg class="tick tick--read" viewBox="0 0 18 11" aria-label="Lida" role="img">
              <path
                d="M1 6l3.5 3.5L11 2M7 9.5L8 10.5 15.5 2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          } @else {
            <svg class="tick tick--sent" viewBox="0 0 18 11" aria-label="Enviada" role="img">
              <path
                d="M4 6l3.5 3.5L14 2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          }
        }
      </span>
      @if (v.kind === 'list') {
        <button type="button" class="bubble__list-btn" (click)="openList.emit(v.list!)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 5h2v2H3zm4 0h14v2H7zM3 11h2v2H3zm4 0h14v2H7zm-4 6h2v2H3zm4 0h14v2H7z"
            />
          </svg>
          {{ v.listButton }}
        </button>
      }
    </div>
    @if (v.kind === 'buttons') {
      <div class="reply-buttons">
        @for (b of v.buttons; track b.id) {
          <button
            type="button"
            class="reply-button"
            (click)="reply.emit({ type: 'button_reply', id: b.id, title: b.title })"
          >
            {{ b.title }}
          </button>
        }
      </div>
    }
  `,
})
export class MessageBubble {
  readonly message = input.required<SimChatMessage>();
  readonly reply = output<InteractiveReply>();
  readonly openList = output<ListInteractive>();

  protected readonly view = computed(() => toMessageView(this.message()));
}
