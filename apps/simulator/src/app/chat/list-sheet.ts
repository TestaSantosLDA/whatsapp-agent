import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { InteractiveReply } from '../core/chat.store';
import type { ListInteractive } from './message-view';

/** Bottom sheet listing the sections and rows of an interactive list message. */
@Component({
  selector: 'app-list-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="sheet-backdrop" (click)="closed.emit()"></div>
    <div class="sheet" role="dialog" aria-modal="true" [attr.aria-label]="list().action.button">
      <div class="sheet__head">
        <button type="button" class="icon-btn" aria-label="Fechar" (click)="closed.emit()">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"
            />
          </svg>
        </button>
        <span class="sheet__title">{{ list().action.button }}</span>
      </div>
      <div class="sheet__body">
        @for (section of list().action.sections; track $index) {
          @if (section.title) {
            <div class="sheet__section">{{ section.title }}</div>
          }
          @for (row of section.rows; track row.id) {
            <button
              type="button"
              class="sheet__row"
              (click)="picked.emit({ type: 'list_reply', id: row.id, title: row.title })"
            >
              <span class="sheet__row-text">
                <span class="sheet__row-title">{{ row.title }}</span>
                @if (row.description) {
                  <span class="sheet__row-desc">{{ row.description }}</span>
                }
              </span>
              <span class="sheet__radio" aria-hidden="true"></span>
            </button>
          }
        }
      </div>
    </div>
  `,
})
export class ListSheet {
  readonly list = input.required<ListInteractive>();
  readonly picked = output<InteractiveReply>();
  readonly closed = output<void>();
}
