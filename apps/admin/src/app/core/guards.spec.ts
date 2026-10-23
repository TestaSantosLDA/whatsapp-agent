import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  UrlTree,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import type { AdminContextView, AdminMe } from '@wa/shared';
import { fakeJwt, FakeSupabaseAuth, json, supabaseConfig } from '../testing';
import { AuthService, SUPABASE_AUTH_FACTORY } from './auth.service';
import { adminGuard, authGuard } from './guards';
import { SessionStore } from './session.store';

const me = (memberships: AdminMe['memberships']): AdminMe => ({
  user: { id: 'u1', email: 'ana@example.pt' },
  memberships,
});
const context = (role: 'admin' | 'sales'): AdminContextView => ({
  member: {
    id: 'm1',
    email: 'ana@example.pt',
    name: 'Ana',
    role,
    branches: ['maia'],
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-10-23T00:00:00Z',
  },
  client: { id: 'jular', name: 'Jular Madeiras', timezone: 'Europe/Lisbon' },
  role,
  branches: [{ id: 'maia', name: 'Maia', region: 'Norte' }],
  allBranches: [{ id: 'maia', name: 'Maia', region: 'Norte' }],
});

describe('guards', () => {
  let supabase: FakeSupabaseAuth;
  let api: Record<string, () => Response>;
  let requests: { url: string; auth: string | null }[];

  beforeEach(() => {
    supabase = new FakeSupabaseAuth();
    requests = [];
    api = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/admin/config') return json(supabaseConfig);
        requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
        const route = api[url];
        if (!route) throw new Error(`unexpected fetch ${url}`);
        return route();
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SUPABASE_AUTH_FACTORY, useValue: async () => supabase },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = (guard: typeof authGuard) =>
    TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    ) as Promise<boolean | UrlTree> | boolean | UrlTree;
  const url = (result: boolean | UrlTree) =>
    result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : result;

  it('sends signed-out visitors to the login screen', async () => {
    expect(url(await run(authGuard))).toBe('/login');
    expect(requests).toEqual([]);
  });

  it('loads the member context with the token, then lets them in', async () => {
    const token = fakeJwt({ sub: 'u1', exp: Date.now() / 1000 + 3600 });
    supabase.session = { access_token: token, user: { email: 'ana@example.pt' } };
    api['/api/admin/me'] = () =>
      json(me([{ clientId: 'jular', clientName: 'Jular', memberId: 'm1', role: 'sales' }]));
    api['/api/admin/clients/jular/context'] = () => json(context('sales'));

    expect(await run(authGuard)).toBe(true);
    expect(requests.map((r) => r.url)).toEqual([
      '/api/admin/me',
      '/api/admin/clients/jular/context',
    ]);
    expect(requests.every((r) => r.auth === `Bearer ${token}`)).toBe(true);
    const session = TestBed.inject(SessionStore);
    expect(session.branches().map((b) => b.id)).toEqual(['maia']);

    // Sales members cannot open Settings.
    expect(url(run(adminGuard) as boolean | UrlTree)).toBe('/');
    session.context.set(context('admin'));
    expect(run(adminGuard)).toBe(true);
  });

  it('explains when the account is on no team', async () => {
    supabase.session = { access_token: fakeJwt({ sub: 'u2' }), user: { email: 'x@example.pt' } };
    api['/api/admin/me'] = () => json(me([]));
    expect(url(await run(authGuard))).toBe('/login?erro=sem-equipa');
  });

  it('signs out when the API rejects the token', async () => {
    supabase.session = { access_token: fakeJwt({ sub: 'u3' }), user: { email: 'x@example.pt' } };
    api['/api/admin/me'] = () => json({ error: 'expired_token', message: 'x' }, 401);
    expect(url(await run(authGuard))).toBe('/login');
    expect(TestBed.inject(AuthService).status()).toBe('signed-out');
  });
});
