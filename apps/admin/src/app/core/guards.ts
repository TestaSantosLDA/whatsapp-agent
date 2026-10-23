import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { ApiError } from './api.service';
import { AuthService } from './auth.service';
import { SessionStore } from './session.store';

/**
 * Signed in and on a client's team, else the login screen. Loads the member's context once, so
 * every screen below can read SessionStore synchronously.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const session = inject(SessionStore);
  const router = inject(Router);
  await auth.ready();
  if (auth.status() !== 'signed-in') return router.createUrlTree(['/login']);
  if (session.loaded) return true;
  try {
    if (await session.load()) return true;
    return router.createUrlTree(['/login'], { queryParams: { erro: 'sem-equipa' } });
  } catch (error) {
    // 401: the session ended (AdminApi has signed out); anything else is worth saying.
    if (error instanceof ApiError && error.status === 401) return router.createUrlTree(['/login']);
    return router.createUrlTree(['/login'], { queryParams: { erro: 'falha' } });
  }
};

/** Admins only (Settings); sales members go back to the start. Use below authGuard. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  return session.isAdmin() || inject(Router).createUrlTree(['/']);
};
