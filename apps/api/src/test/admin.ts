/**
 * Test helpers for the admin API (WA-022): a locally generated signing key standing in for a
 * Supabase project's, and tokens shaped like Supabase's. No Supabase project is needed.
 */
import { randomUUID } from 'node:crypto';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';
import type { TeamRole } from '@wa/shared';
import { testApp } from './helpers.js';

export const SUPABASE_URL = 'https://testproject.supabase.co';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

export interface TestKeys {
  privateKey: CryptoKey;
  jwk: JWK;
  kid: string;
}

export async function testKeys(alg: 'ES256' | 'RS256' = 'ES256'): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { privateKey, jwk, kid };
}

export function jwksOf(...keys: TestKeys[]) {
  return createLocalJWKSet({ keys: keys.map((k) => k.jwk) });
}

/** A Supabase-like access token. `claims` and `opts` override the defaults to test failures. */
export function signToken(
  keys: TestKeys,
  user: { id: string; email?: string },
  claims: JWTPayload = {},
  opts: { alg?: string; expiresIn?: string | number; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ email: user.email, role: 'authenticated', aal: 'aal1', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? (keys.jwk.alg as string), kid: keys.kid, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(keys.privateKey);
}

/** An app with Supabase Auth "configured" against a local key, plus helpers to call it. */
export async function adminTestApp(opts: Parameters<typeof testApp>[0] = {}) {
  const keys = await testKeys();
  const t = await testApp({
    ...opts,
    env: { SUPABASE_URL, ...opts.env },
    jwks: opts.jwks ?? jwksOf(keys),
  });

  /** Adds a member and returns a token for a Supabase user signed in as them. */
  const member = async (
    clientId: string,
    m: { email: string; role: TeamRole; branches?: string[]; name?: string },
  ) => {
    const [row] = await t.team.ensure(clientId, [m]);
    const userId = randomUUID();
    const token = await signToken(keys, { id: userId, email: m.email });
    return { row: row!, userId, token };
  };

  const call = (path: string, token: string | undefined, init: RequestInit = {}) =>
    t.app.request(path, {
      ...init,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  return { ...t, keys, member, call };
}
