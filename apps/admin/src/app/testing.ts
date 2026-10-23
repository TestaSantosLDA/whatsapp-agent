/** Test doubles shared by the specs. */
import type { AdminConfig } from '@wa/shared';
import type { SessionLike, SupabaseAuthLike } from './core/auth.service';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A JWT-shaped string with these claims (unsigned: the browser never verifies tokens). */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

export class FakeSupabaseAuth implements SupabaseAuthLike {
  session: SessionLike | null = null;
  calls: { method: string; args: unknown }[] = [];
  listener: ((event: string, session: SessionLike | null) => void) | null = null;
  error: string | null = null;

  private result() {
    return Promise.resolve({ error: this.error ? { message: this.error } : null });
  }
  getSession() {
    return Promise.resolve({ data: { session: this.session } });
  }
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void) {
    this.listener = callback;
    return {};
  }
  signInWithOtp(args: unknown) {
    this.calls.push({ method: 'signInWithOtp', args });
    return this.result();
  }
  verifyOtp(args: unknown) {
    this.calls.push({ method: 'verifyOtp', args });
    return this.result();
  }
  signInWithOAuth(args: unknown) {
    this.calls.push({ method: 'signInWithOAuth', args });
    return this.result();
  }
  signOut(args?: unknown) {
    this.calls.push({ method: 'signOut', args });
    return this.result();
  }
}

export const supabaseConfig: AdminConfig = {
  supabaseUrl: 'https://proj.supabase.co',
  supabaseAnonKey: 'anon-key',
  devLogin: false,
};
