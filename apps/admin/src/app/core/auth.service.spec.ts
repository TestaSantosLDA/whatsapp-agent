import { TestBed } from '@angular/core/testing';
import { fakeJwt, FakeSupabaseAuth, json, supabaseConfig } from '../testing';
import { AuthService, REDIRECT_URL, SUPABASE_AUTH_FACTORY } from './auth.service';

describe('AuthService', () => {
  let supabase: FakeSupabaseAuth;
  let fetchMock: ReturnType<typeof vi.fn>;
  let created: { url: string; key: string }[];

  function setup(config = supabaseConfig, routes: Record<string, () => Response> = {}) {
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/admin/config') return json(config);
      const route = routes[url];
      if (route) return route();
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SUPABASE_AUTH_FACTORY,
          useValue: async (url: string, key: string) => {
            created.push({ url, key });
            return supabase;
          },
        },
        { provide: REDIRECT_URL, useValue: 'https://wa.example/admin/' },
      ],
    });
    return TestBed.inject(AuthService);
  }

  beforeEach(() => {
    supabase = new FakeSupabaseAuth();
    created = [];
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts Supabase with the config from the API and picks up an existing session', async () => {
    const token = fakeJwt({ sub: 'u1', exp: Date.now() / 1000 + 3600 });
    supabase.session = { access_token: token, user: { email: 'ana@example.pt' } };
    const auth = setup();
    await auth.ready();
    expect(created).toEqual([{ url: 'https://proj.supabase.co', key: 'anon-key' }]);
    expect(auth.status()).toBe('signed-in');
    expect(auth.token()).toBe(token);
    expect(auth.userId()).toBe('u1');
    expect(auth.email()).toBe('ana@example.pt');
  });

  it('is signed out without a session, and follows Supabase auth events', async () => {
    const auth = setup();
    await auth.ready();
    expect(auth.status()).toBe('signed-out');
    supabase.listener!('SIGNED_IN', { access_token: 't2', user: { email: 'b@example.pt' } });
    expect(auth.status()).toBe('signed-in');
    expect(auth.token()).toBe('t2');
    supabase.listener!('SIGNED_OUT', null);
    expect(auth.status()).toBe('signed-out');
    expect(auth.token()).toBeNull();
  });

  it('sends invite-only magic links and codes, and Google sign-in, back to the dashboard', async () => {
    const auth = setup();
    await auth.ready();
    await auth.sendMagicLink(' Ana@Example.PT ');
    await auth.verifyCode('ana@example.pt', ' 123456 ');
    await auth.signInWithGoogle();
    expect(supabase.calls).toEqual([
      {
        method: 'signInWithOtp',
        args: {
          email: 'ana@example.pt',
          options: { shouldCreateUser: false, emailRedirectTo: 'https://wa.example/admin/' },
        },
      },
      { method: 'verifyOtp', args: { email: 'ana@example.pt', token: '123456', type: 'email' } },
      {
        method: 'signInWithOAuth',
        args: { provider: 'google', options: { redirectTo: 'https://wa.example/admin/' } },
      },
    ]);
    supabase.error = 'Signups not allowed for otp';
    await expect(auth.sendMagicLink('x@example.pt')).rejects.toThrow(/Signups not allowed/);
  });

  it('signs in with the dev login, keeps the token across reloads and signs out', async () => {
    const token = fakeJwt({ sub: 'dev-user', exp: Date.now() / 1000 + 3600 });
    const devConfig = { supabaseUrl: null, supabaseAnonKey: null, devLogin: true };
    const auth = setup(devConfig, { '/api/admin/dev/login': () => json({ access_token: token }) });
    await auth.ready();
    expect(created).toEqual([]);
    expect(auth.status()).toBe('signed-out');
    await auth.devLogin({
      id: 'm1',
      clientId: 'jular',
      email: 'admin@example.invalid',
      name: null,
      role: 'admin',
      branches: [],
    });
    expect(auth.status()).toBe('signed-in');
    expect(auth.mode()).toBe('dev');

    // A reload: a fresh service finds the stored dev token.
    TestBed.resetTestingModule();
    const again = setup(devConfig);
    await again.ready();
    expect(again.token()).toBe(token);

    await again.signOut();
    expect(again.status()).toBe('signed-out');
    expect(localStorage.getItem('wa-admin.devToken')).toBeNull();
  });

  it('ignores a stored dev token once the dev login is off', async () => {
    localStorage.setItem(
      'wa-admin.devToken',
      fakeJwt({ sub: 'dev-user', exp: Date.now() / 1000 + 3600 }),
    );
    const auth = setup();
    await auth.ready();
    expect(auth.mode()).toBeNull();
    expect(auth.status()).toBe('signed-out');
    expect(localStorage.getItem('wa-admin.devToken')).toBeNull();
  });
});
