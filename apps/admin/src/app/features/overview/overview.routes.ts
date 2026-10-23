import type { Routes } from '@angular/router';

/**
 * Resumo (WA-029): this week's and month's figures per branch for everyone (scoped by the API);
 * the "couldn't answer" list for admins; most asked products and searches with no result.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Resumo',
    loadComponent: () => import('./overview.page').then((m) => m.OverviewPage),
  },
];
