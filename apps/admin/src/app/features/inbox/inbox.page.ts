import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnDestroy,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { InboxView } from '@wa/shared';
import { SessionStore } from '../../core/session.store';
import { contactLabel, shortWhen, STATUS_LABELS } from './format';
import { InboxStore } from './inbox.store';

const VIEWS: { id: InboxView; label: string }[] = [
  { id: 'human', label: 'Precisam de pessoa' },
  { id: 'mine', label: 'Minhas' },
  { id: 'all', label: 'Todas' },
];

/**
 * Conversas (WA-023): the list, and the open conversation beside it on desktop. On phones the
 * list and the conversation are separate screens.
 */
@Component({
  selector: 'app-inbox-page',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="inbox" [class.inbox--open]="store.openId() !== null">
      <section class="inbox__list" aria-label="Conversas">
        <header class="page__head">
          <div class="inbox__title">
            <h1 class="page__title">Conversas</h1>
            <span class="live" [class.live--on]="store.live()" role="status">
              {{ store.live() ? 'Em direto' : 'A ligar…' }}
            </span>
          </div>
          <div class="subtabs" role="group" aria-label="Filtro">
            @for (v of views; track v.id) {
              <button
                type="button"
                class="subtab"
                [class.subtab--active]="store.view() === v.id"
                [attr.aria-pressed]="store.view() === v.id"
                (click)="store.setView(v.id)"
              >
                {{ v.label }}
                @if (v.id === 'human' && store.needsPerson()) {
                  <span class="count">{{ store.needsPerson() }}</span>
                }
              </button>
            }
          </div>
          @if (branches().length > 1) {
            <select
              class="input input--sm inbox__branch"
              aria-label="Filial"
              [value]="store.branch()"
              (change)="store.setBranch($any($event.target).value)"
            >
              <option value="">Todas as filiais</option>
              @for (b of branches(); track b.id) {
                <option [value]="b.id">{{ b.name }}</option>
              }
            </select>
          }
        </header>

        @if (store.error()) {
          <p class="notice notice--error" role="alert">{{ store.error() }}</p>
        }

        <ul class="convs">
          @for (c of store.conversations(); track c.id) {
            <li>
              <a
                class="conv"
                [routerLink]="c.id"
                routerLinkActive="conv--active"
                [class.conv--unread]="c.unread > 0"
              >
                <span class="avatar" aria-hidden="true">{{ initial(c.contact) }}</span>
                <span class="conv__main">
                  <span class="conv__top">
                    <span class="conv__name">{{ label(c.contact) }}</span>
                    <span class="conv__when">{{ when(c.lastActivityAt) }}</span>
                  </span>
                  <span class="conv__last">
                    @if (c.lastMessage; as m) {
                      @if (m.direction === 'outbound') {
                        <span class="conv__by">{{ m.byMember ? 'Equipa:' : 'Assistente:' }}</span>
                      }
                      {{ m.text }}
                    }
                  </span>
                  <span class="conv__meta">
                    <span class="conv-status conv-status--{{ c.status }}">{{
                      statusLabel[c.status]
                    }}</span>
                    @if (c.branchName) {
                      <span class="muted">{{ c.branchName }}</span>
                    }
                    @if (c.assignedTo; as a) {
                      <span class="muted"
                        >· {{ a.id === store.memberId() ? 'Eu' : a.name || a.email }}</span
                      >
                    }
                  </span>
                </span>
                @if (c.unread > 0) {
                  <span class="badge" [attr.aria-label]="c.unread + ' por ler'">{{
                    c.unread
                  }}</span>
                }
              </a>
            </li>
          } @empty {
            @if (!store.loading()) {
              <li class="card empty">
                <p class="empty__text">{{ emptyText() }}</p>
              </li>
            }
          }
        </ul>
      </section>

      <section class="inbox__detail">
        <router-outlet />
      </section>
    </div>
  `,
})
export class InboxPage implements OnDestroy {
  protected readonly store = inject(InboxStore);
  private readonly session = inject(SessionStore);
  protected readonly views = VIEWS;
  protected readonly statusLabel = STATUS_LABELS;
  protected readonly branches = computed(() => this.session.branches());
  protected readonly label = contactLabel;
  protected readonly when = (iso: string) => shortWhen(iso);
  protected readonly emptyText = computed(
    () =>
      ({
        human:
          'Ninguém está à espera de uma pessoa. Quando o assistente passar uma conversa, aparece aqui.',
        mine: 'Não tem conversas atribuídas.',
        all: 'Ainda não há conversas.',
      })[this.store.view()],
  );

  constructor() {
    void this.store.load();
    this.store.connect();
  }

  ngOnDestroy(): void {
    this.store.disconnect();
  }

  protected initial(contact: { name: string | null; phone: string }): string {
    return (contact.name?.trim()[0] ?? '#').toUpperCase();
  }
}

/** The empty right pane on desktop. */
@Component({
  selector: 'app-inbox-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card empty inbox__pick">
      <p class="empty__text">Escolha uma conversa para ver as mensagens e responder.</p>
    </div>
  `,
})
export class InboxEmpty {}
