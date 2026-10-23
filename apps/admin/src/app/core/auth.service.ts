import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import type { AdminConfig, DevLoginMember } from '@wa/shared';
import { storageGet, storageSet } from './storage';

/** The part of a Supabase session the dashboard uses. */
export interface SessionLike {
  access_token: string;
  /** Seconds since the epoch. */
  expires_at?: number;
  user: { email?: string | null };
}

interface AuthResult {
  error: { message: string } | null;
}

/** The part of `supabase.auth` the dashboard uses, so tests can swap in a fake. */
export interface SupabaseAuthLike {
  getSession(): Promise<{ data: { session: SessionLike | null } }>;
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): unknown;
  signInWithOtp(credentials: {
    email: string;
    options: { shouldCreateUser: boolean; emailRedirectTo: string };
  }): Promise<AuthResult>;
  verifyOtp(params: { email: string; token: string; type: 'email' }): Promise<AuthResult>;
  signInWithOAuth(credentials: {
    provider: 'google';
    options: { redirectTo: string };
  }): Promise<AuthResult>;
  signOut(options?: { scope: 'local' }): Promise<AuthResult>;
}

/** Builds the Supabase client. Loaded lazily: the library is only fetched when it is needed. */
export const SUPABASE_AUTH_FACTORY = new InjectionToken<
  (url: string, anonKey: string) => Promise<SupabaseAuthLike>
>('SUPABASE_AUTH_FACTORY', {
  providedIn: 'root',
  factory: () => async (url, anonKey) => {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(url, anonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'wa-admin.auth',
      },
    });
    return client.auth as unknown as SupabaseAuthLike;
  },
});

/** Where magic links and Google send people back: the dashboard's own root. */
export const REDIRECT_URL = new InjectionToken<string>('REDIRECT_URL', {
  providedIn: 'root',
  factory: () => new URL(document.baseURI).href,
});

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

const DEV_TOKEN_KEY = 'wa-admin.devToken';

/** The token's claims, unverified (the API verifies them); empty when unreadable. */
export function tokenClaims(token: string | null): { sub?: string; exp?: number } {
  if (!token) return {};
  try {
    return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

/**
 * Sign-in for the dashboard (WA-022): Supabase Auth with an email link or code, or Google; in
 * local development, the API's dev login. Holds the access token the API calls send.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly createAuth = inject(SUPABASE_AUTH_FACTORY);
  private readonly redirectUrl = inject(REDIRECT_URL);

  readonly status = signal<AuthStatus>('loading');
  readonly config = signal<AdminConfig | null>(null);
  readonly token = signal<string | null>(null);
  readonly email = signal<string | null>(null);
  readonly mode = signal<'supabase' | 'dev' | null>(null);
  /** The signed-in user's id (`sub`), changes only when someone else signs in. */
  readonly userId = computed(() => tokenClaims(this.token()).sub ?? null);
  /** Supabase is configured on the API: show the email and Google sign-in. */
  readonly supabaseEnabled = computed(() => Boolean(this.config()?.supabaseUrl));
  readonly devLoginEnabled = computed(() => Boolean(this.config()?.devLogin));

  private supabase: SupabaseAuthLike | null = null;
  private initPromise: Promise<void> | null = null;

  /** Resolves once the current session (if any) is known. Safe to call many times. */
  ready(): Promise<void> {
    this.initPromise ??= this.init();
    return this.initPromise;
  }

  private async init(): Promise<void> {
    try {
      const res = await fetch('/admin/config', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET /admin/config failed: ${res.status}`);
      this.config.set((await res.json()) as AdminConfig);
    } catch (error) {
      console.error(error);
      this.config.set({ supabaseUrl: null, supabaseAnonKey: null, devLogin: false });
    }
    const config = this.config()!;

    const devToken = config.devLogin ? storageGet(DEV_TOKEN_KEY) : null;
    if (devToken && (tokenClaims(devToken).exp ?? 0) * 1000 > Date.now()) {
      this.setSession('dev', devToken);
      return;
    }
    storageSet(DEV_TOKEN_KEY, null);

    if (config.supabaseUrl && config.supabaseAnonKey) {
      try {
        this.supabase = await this.createAuth(config.supabaseUrl, config.supabaseAnonKey);
        this.supabase.onAuthStateChange((_event, session) => {
          if (this.mode() === 'dev') return;
          if (session) this.setSession('supabase', session.access_token, session.user.email);
          else this.clear();
        });
        // Also finishes a magic link or Google redirect (the code in the URL).
        const { data } = await this.supabase.getSession();
        if (data.session) {
          this.setSession('supabase', data.session.access_token, data.session.user.email);
          return;
        }
      } catch (error) {
        console.error('[auth] Supabase failed to start', error);
      }
    }
    if (this.status() === 'loading') this.status.set('signed-out');
  }

  /** Emails a sign-in link (and code). Only invited people get one: sign-ups are disabled. */
  async sendMagicLink(email: string): Promise<void> {
    const { error } = await this.requireSupabase().signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false, emailRedirectTo: this.redirectUrl },
    });
    if (error) throw new Error(error.message);
  }

  /** Signs in with the code from the same email, for phones where the link opens elsewhere. */
  async verifyCode(email: string, code: string): Promise<void> {
    const { error } = await this.requireSupabase().verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });
    if (error) throw new Error(error.message);
  }

  async signInWithGoogle(): Promise<void> {
    const { error } = await this.requireSupabase().signInWithOAuth({
      provider: 'google',
      options: { redirectTo: this.redirectUrl },
    });
    if (error) throw new Error(error.message);
  }

  async devMembers(): Promise<DevLoginMember[]> {
    const res = await fetch('/api/admin/dev/members', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /api/admin/dev/members failed: ${res.status}`);
    return (await res.json()) as DevLoginMember[];
  }

  async devLogin(member: DevLoginMember): Promise<void> {
    const res = await fetch('/api/admin/dev/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: member.id }),
    });
    if (!res.ok) throw new Error(`POST /api/admin/dev/login failed: ${res.status}`);
    const { access_token } = (await res.json()) as { access_token: string };
    storageSet(DEV_TOKEN_KEY, access_token);
    this.setSession('dev', access_token, member.email);
  }

  async signOut(): Promise<void> {
    const wasSupabase = this.mode() === 'supabase';
    storageSet(DEV_TOKEN_KEY, null);
    this.clear();
    if (wasSupabase && this.supabase) {
      await this.supabase.signOut({ scope: 'local' }).catch(() => undefined);
    }
  }

  private setSession(mode: 'supabase' | 'dev', token: string, email?: string | null): void {
    this.mode.set(mode);
    this.token.set(token);
    this.email.set(email ?? null);
    this.status.set('signed-in');
  }

  private clear(): void {
    this.mode.set(null);
    this.token.set(null);
    this.email.set(null);
    this.status.set('signed-out');
  }

  private requireSupabase(): SupabaseAuthLike {
    if (!this.supabase) throw new Error('O início de sessão não está configurado.');
    return this.supabase;
  }
}
