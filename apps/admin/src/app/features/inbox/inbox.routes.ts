import type { Routes } from '@angular/router';
import { ComingSoon } from '../../shared/coming-soon';

/** Conversas (WA-023): placeholder until the ticket replaces it with its own screens. */
export const routes: Routes = [
  {
    path: '',
    component: ComingSoon,
    title: 'Conversas',
    data: {
      title: 'Conversas',
      ticket: 'WA-023',
      text: 'As conversas com os clientes, as que precisam de uma pessoa primeiro. Aqui vai poder assumir uma conversa, responder como pessoa e devolvê-la ao assistente.',
    },
  },
];
