import type { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/guards';
import { Shell } from './shell/shell';

/**
 * Every screen is a lazy feature in features/<path>/<path>.routes.ts, listed here and in
 * shell/nav.ts. See "Admin dashboard" in docs/architecture.md.
 */
export const routes: Routes = [
  {
    path: 'login',
    title: 'Entrar',
    loadComponent: () => import('./login/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'inbox' },
      {
        path: 'inbox',
        loadChildren: () => import('./features/inbox/inbox.routes').then((m) => m.routes),
      },
      {
        path: 'leads',
        loadChildren: () => import('./features/leads/leads.routes').then((m) => m.routes),
      },
      {
        path: 'customers',
        loadChildren: () => import('./features/customers/customers.routes').then((m) => m.routes),
      },
      {
        path: 'knowledge',
        loadChildren: () => import('./features/knowledge/knowledge.routes').then((m) => m.routes),
      },
      {
        path: 'overview',
        loadChildren: () => import('./features/overview/overview.routes').then((m) => m.routes),
      },
      {
        path: 'privacy',
        canActivate: [adminGuard],
        loadChildren: () => import('./features/privacy/privacy.routes').then((m) => m.routes),
      },
      {
        path: 'settings',
        canActivate: [adminGuard],
        loadChildren: () => import('./features/settings/settings.routes').then((m) => m.routes),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
