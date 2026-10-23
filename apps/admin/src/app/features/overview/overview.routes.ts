import type { Routes } from '@angular/router';
import { ComingSoon } from '../../shared/coming-soon';

/** Resumo (WA-029): placeholder until the ticket replaces it with its own screens. */
export const routes: Routes = [
  {
    path: '',
    component: ComingSoon,
    title: 'Resumo',
    data: {
      title: 'Resumo',
      ticket: 'WA-029',
      text: 'Os números da semana e do mês por filial, e as perguntas a que o assistente não soube responder.',
    },
  },
];
