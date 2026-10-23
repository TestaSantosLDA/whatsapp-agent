import type { Routes } from '@angular/router';

/** Pedidos (WA-024): the list, and one lead's page. */
export const routes: Routes = [
  {
    path: '',
    title: 'Pedidos',
    loadComponent: () => import('./leads.page').then((m) => m.LeadsPage),
  },
  {
    path: ':id',
    title: 'Pedido',
    loadComponent: () => import('./lead.page').then((m) => m.LeadPage),
  },
];
