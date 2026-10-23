import type { Routes } from '@angular/router';
import { InboxEmpty, InboxPage } from './inbox.page';
import { InboxStore } from './inbox.store';

/** Conversas (WA-023): the list, and a conversation by id (beside it on desktop). */
export const routes: Routes = [
  {
    path: '',
    component: InboxPage,
    providers: [InboxStore],
    children: [
      { path: '', title: 'Conversas', component: InboxEmpty },
      {
        path: ':id',
        title: 'Conversa',
        loadComponent: () => import('./conversation.page').then((m) => m.ConversationPage),
      },
    ],
  },
];
