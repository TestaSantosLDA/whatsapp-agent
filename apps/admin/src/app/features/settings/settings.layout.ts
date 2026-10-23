import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-settings-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">Definições</h1>
        <nav class="subtabs" aria-label="Definições">
          <a
            class="subtab"
            routerLink="."
            routerLinkActive="subtab--active"
            [routerLinkActiveOptions]="{ exact: true }"
            >Atendimento e filiais</a
          >
          <a class="subtab" routerLink="team" routerLinkActive="subtab--active">Equipa</a>
        </nav>
      </header>
      <router-outlet />
    </section>
  `,
})
export class SettingsLayout {}
