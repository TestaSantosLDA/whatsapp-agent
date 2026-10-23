import type { Routes } from '@angular/router';
import { ComingSoon } from '../../shared/coming-soon';

/** Clientes (WA-027): placeholder until the ticket replaces it with its own screens. */
export const routes: Routes = [
  {
    path: '',
    component: ComingSoon,
    title: 'Clientes',
    data: {
      title: 'Clientes',
      ticket: 'WA-027',
      text: 'A ficha de cada cliente: contactos, conversas, pedidos e preferências.',
    },
  },
];
