import type { Routes } from '@angular/router';

/** Orçamentos (WA-025): a quote's editor. Quotes are created from a lead's page. */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: '/leads' },
  {
    path: ':id',
    title: 'Orçamento',
    loadComponent: () => import('./quote.page').then((m) => m.QuotePage),
  },
];
