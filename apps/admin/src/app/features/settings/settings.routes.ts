import type { Routes } from '@angular/router';
import { SettingsLayout } from './settings.layout';

/** Definições (admins only, guarded in app.routes.ts): rules per branch, and the team. */
export const routes: Routes = [
  {
    path: '',
    component: SettingsLayout,
    children: [
      {
        path: '',
        title: 'Definições',
        loadComponent: () => import('./settings.page').then((m) => m.SettingsPage),
      },
      {
        path: 'team',
        title: 'Equipa',
        loadComponent: () => import('./team.page').then((m) => m.TeamPage),
      },
    ],
  },
];
