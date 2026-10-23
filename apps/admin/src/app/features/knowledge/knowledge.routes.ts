import type { Routes } from '@angular/router';

/**
 * Conhecimento (WA-026): files the assistant reads (technical sheets, price lists, catalogues),
 * and the review of the product data Claude proposed from each. Sales can read; admins upload
 * and decide (the API enforces it).
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Conhecimento',
    loadComponent: () => import('./knowledge.page').then((m) => m.KnowledgePage),
  },
  {
    path: ':id',
    title: 'Rever documento',
    loadComponent: () => import('./document.page').then((m) => m.DocumentPage),
  },
];
