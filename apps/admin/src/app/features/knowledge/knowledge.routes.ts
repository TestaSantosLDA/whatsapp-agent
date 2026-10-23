import type { Routes } from '@angular/router';
import { ComingSoon } from '../../shared/coming-soon';

/** Conhecimento (WA-026): placeholder until the ticket replaces it with its own screens. */
export const routes: Routes = [
  {
    path: '',
    component: ComingSoon,
    title: 'Conhecimento',
    data: {
      title: 'Conhecimento',
      ticket: 'WA-026',
      text: 'Fichas técnicas, tabelas de preços e catálogos que o assistente usa para responder.',
    },
  },
];
