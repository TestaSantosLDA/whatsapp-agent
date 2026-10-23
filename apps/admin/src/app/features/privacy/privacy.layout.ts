import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-privacy-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">Privacidade</h1>
        <nav class="subtabs" aria-label="Privacidade">
          <a
            class="subtab"
            routerLink="."
            routerLinkActive="subtab--active"
            [routerLinkActiveOptions]="{ exact: true }"
            >Clientes</a
          >
          <a class="subtab" routerLink="requests" routerLinkActive="subtab--active">Pedidos</a>
          <a class="subtab" routerLink="retention" routerLinkActive="subtab--active">Retenção</a>
          <a class="subtab" routerLink="audit" routerLinkActive="subtab--active">Registo</a>
        </nav>
      </header>
      <router-outlet />
    </section>
  `,
})
export class PrivacyLayout {}
