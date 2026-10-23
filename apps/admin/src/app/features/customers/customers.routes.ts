import type { Routes } from '@angular/router';

/** Clientes (WA-027): the list, and one customer's record. */
export const routes: Routes = [
  {
    path: '',
    title: 'Clientes',
    loadComponent: () => import('./customers.page').then((m) => m.CustomersPage),
  },
  {
    path: ':id',
    title: 'Cliente',
    loadComponent: () => import('./customer.page').then((m) => m.CustomerPage),
  },
];
