import type { Routes } from '@angular/router';
import { PrivacyLayout } from './privacy.layout';

/**
 * Privacidade (WA-028, admins only, guarded in app.routes.ts): a customer's data (export, clear
 * profile, delete), requests from WhatsApp, the retention list and the audit log.
 */
export const routes: Routes = [
  {
    path: '',
    component: PrivacyLayout,
    children: [
      {
        path: '',
        title: 'Privacidade',
        loadComponent: () => import('./privacy-home.page').then((m) => m.PrivacyHomePage),
      },
      {
        path: 'requests',
        title: 'Pedidos de privacidade',
        loadComponent: () => import('./requests.page').then((m) => m.PrivacyRequestsPage),
      },
      {
        path: 'retention',
        title: 'Retenção',
        loadComponent: () => import('./retention.page').then((m) => m.PrivacyRetentionPage),
      },
      {
        path: 'audit',
        title: 'Registo de privacidade',
        loadComponent: () => import('./audit.page').then((m) => m.PrivacyAuditPage),
      },
    ],
  },
];
