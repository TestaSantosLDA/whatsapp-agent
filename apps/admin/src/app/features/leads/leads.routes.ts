import type { Routes } from '@angular/router';
import { ComingSoon } from '../../shared/coming-soon';

/** Pedidos (WA-024): placeholder until the ticket replaces it with its own screens. */
export const routes: Routes = [
  {
    path: '',
    component: ComingSoon,
    title: 'Pedidos',
    data: {
      title: 'Pedidos',
      ticket: 'WA-024',
      text: 'Pedidos de orçamento, amostras e encomendas, com responsável, estado e alertas quando ficam sem resposta.',
    },
  },
];
