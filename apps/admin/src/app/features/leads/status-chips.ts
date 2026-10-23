import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import {
  leadStatusLabels,
  lostReasonLabels,
  lostReasons,
  type LeadStatus,
  type LostReason,
} from '@wa/shared';
import type { StatusChange } from './leads.data';

/**
 * One-tap status changes. `options` are the statuses offered; tapping "Perdido" asks for the
 * reason (one more tap) before anything is sent.
 */
@Component({
  selector: 'app-status-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!askingReason()) {
      <div class="schips" role="group" [attr.aria-label]="label()">
        @for (s of options(); track s) {
          <button
            type="button"
            class="schip"
            [class]="'schip schip--' + s"
            [class.schip--on]="s === current()"
            [attr.aria-pressed]="s === current()"
            [disabled]="disabled()"
            (click)="pick(s)"
          >
            {{ labels[s] }}
          </button>
        }
      </div>
    } @else {
      <div class="schips" role="group" aria-label="Motivo da perda">
        <span class="small muted">Motivo:</span>
        @for (r of reasons; track r) {
          <button
            type="button"
            class="schip schip--reason"
            [disabled]="disabled()"
            (click)="lose(r)"
          >
            {{ reasonLabels[r] }}
          </button>
        }
        <button type="button" class="btn btn--ghost btn--sm" (click)="askingReason.set(false)">
          Cancelar
        </button>
      </div>
    }
  `,
  styles: `
    .schips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .schip {
      min-height: 32px;
      padding: 4px 12px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fff;
      color: #3b4a54;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
    }
    .schip:hover:not(:disabled) {
      border-color: var(--teal);
    }
    .schip--on {
      color: #fff;
      border-color: transparent;
      background: var(--chip, var(--teal));
    }
    .schip--new {
      --chip: #2f6fb3;
    }
    .schip--contacted {
      --chip: #7a5bc4;
    }
    .schip--quoted {
      --chip: #b7791f;
    }
    .schip--won {
      --chip: var(--teal);
    }
    .schip--lost {
      --chip: var(--danger);
    }
    .schip--reason {
      background: var(--danger-soft);
      border-color: transparent;
      color: #8a1f17;
    }
  `,
})
export class StatusChips {
  readonly options = input.required<readonly LeadStatus[]>();
  /** Highlighted as the lead's status (on the lead page, where every status is offered). */
  readonly current = input<LeadStatus | null>(null);
  readonly disabled = input(false);
  readonly label = input('Mudar o estado');
  readonly changed = output<StatusChange>();

  protected readonly labels = leadStatusLabels;
  protected readonly reasonLabels = lostReasonLabels;
  protected readonly reasons = lostReasons;
  protected readonly askingReason = signal(false);

  protected pick(status: LeadStatus): void {
    if (status === this.current()) return;
    if (status === 'lost') {
      this.askingReason.set(true);
      return;
    }
    this.changed.emit({ status });
  }

  protected lose(lostReason: LostReason): void {
    this.askingReason.set(false);
    this.changed.emit({ status: 'lost', lostReason });
  }
}

/** The lead's status as a coloured label. */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="sbadge" [class]="'sbadge sbadge--' + status()">{{
    labels[status()]
  }}</span>`,
  styles: `
    .sbadge {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      border-radius: 10px;
      padding: 2px 9px;
      white-space: nowrap;
      color: var(--c);
      background: color-mix(in srgb, var(--c) 13%, #fff);
    }
    .sbadge--new {
      --c: #2f6fb3;
    }
    .sbadge--contacted {
      --c: #6a4bb4;
    }
    .sbadge--quoted {
      --c: #9a6212;
    }
    .sbadge--won {
      --c: var(--teal-dark);
    }
    .sbadge--lost {
      --c: var(--danger);
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<LeadStatus>();
  protected readonly labels = leadStatusLabels;
}
