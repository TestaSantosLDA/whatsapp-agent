import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { SessionStore } from '../core/session.store';
import { NAV_ITEMS } from './nav';

/**
 * The signed-in layout: a side bar on desktop, a top bar and a bottom tab bar on phones, and the
 * current feature's screen in the middle.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <header class="topbar">
        <span class="brand-mark" aria-hidden="true">W</span>
        <div class="topbar__title">
          <span class="topbar__client">{{ session.clientName() }}</span>
          <span class="topbar__role">{{ roleLabel() }}</span>
        </div>
        <button type="button" class="btn btn--ghost btn--sm" (click)="signOut()">Sair</button>
      </header>

      <nav class="sidenav" aria-label="Navegação principal">
        <div class="sidenav__brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <div>
            <div class="sidenav__client">{{ session.clientName() }}</div>
            <div class="sidenav__sub">Painel da equipa</div>
          </div>
        </div>
        @if (session.memberships().length > 1) {
          <label class="sidenav__switch">
            <span class="sr-only">Cliente</span>
            <select
              class="input"
              [value]="session.context()?.client?.id"
              (change)="switchClient($any($event.target).value)"
            >
              @for (m of session.memberships(); track m.clientId) {
                <option [value]="m.clientId">{{ m.clientName }}</option>
              }
            </select>
          </label>
        }
        <ul class="sidenav__list">
          @for (item of items(); track item.path) {
            <li>
              <a
                class="navlink"
                [routerLink]="item.path"
                routerLinkActive="navlink--active"
                ariaCurrentWhenActive="page"
              >
                <svg class="navlink__icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path [attr.d]="item.icon" />
                </svg>
                <span>{{ item.label }}</span>
              </a>
            </li>
          }
        </ul>
        <div class="sidenav__user">
          <div class="sidenav__email" [title]="auth.email() ?? ''">{{ auth.email() }}</div>
          <div class="sidenav__sub">{{ roleLabel() }}{{ branchesLabel() }}</div>
          <button type="button" class="btn btn--ghost btn--sm" (click)="signOut()">
            Terminar sessão
          </button>
        </div>
      </nav>

      <main class="shell__main">
        <router-outlet />
      </main>

      <nav class="tabbar" aria-label="Navegação principal">
        @for (item of items(); track item.path) {
          <a
            class="tab"
            [routerLink]="item.path"
            routerLinkActive="tab--active"
            ariaCurrentWhenActive="page"
          >
            <svg class="tab__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path [attr.d]="item.icon" />
            </svg>
            <span class="tab__label">{{ item.short }}</span>
          </a>
        }
      </nav>
    </div>
  `,
})
export class Shell {
  protected readonly session = inject(SessionStore);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly items = computed(() =>
    NAV_ITEMS.filter((item) => !item.adminOnly || this.session.isAdmin()),
  );
  protected readonly roleLabel = computed(() =>
    this.session.isAdmin() ? 'Administrador' : 'Comercial',
  );
  protected readonly branchesLabel = computed(() => {
    if (this.session.isAdmin()) return '';
    const names = this.session.branches().map((b) => b.name);
    return names.length ? ` · ${names.join(', ')}` : '';
  });

  protected async switchClient(clientId: string): Promise<void> {
    await this.session.switchClient(clientId);
    await this.router.navigateByUrl('/');
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    this.session.reset();
    await this.router.navigateByUrl('/login');
  }
}
