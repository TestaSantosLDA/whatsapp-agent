import { randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ISSUER, jwksOf, signToken, SUPABASE_URL, testKeys } from '../test/admin.js';
import { AuthError, bearerToken, signDevToken, SupabaseJwtVerifier } from './auth.js';

const user = { id: randomUUID(), email: 'Ana@Example.invalid' };
const HS_SECRET = 'a-legacy-supabase-jwt-secret-of-32-chars-or-more';

async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
}

describe('SupabaseJwtVerifier', () => {
  it('accepts an ES256 token signed by a key in the JWKS, lower-casing the email', async () => {
    const keys = await testKeys('ES256');
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: jwksOf(keys) });
    expect(await verifier.verify(await signToken(keys, user))).toEqual({
      id: user.id,
      email: 'ana@example.invalid',
    });
  });

  it('fetches the project JWKS once and caches it', async () => {
    const keys = await testKeys('RS256');
    const urls: string[] = [];
    const verifier = new SupabaseJwtVerifier({
      supabaseUrl: `${SUPABASE_URL}/`,
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({ keys: [keys.jwk] });
      },
    });
    await verifier.verify(await signToken(keys, user));
    await verifier.verify(await signToken(keys, user));
    expect(urls).toEqual([`${ISSUER}/.well-known/jwks.json`]);
  });

  it('accepts legacy HS256 tokens only when SUPABASE_JWT_SECRET is set', async () => {
    const secret = new TextEncoder().encode(HS_SECRET);
    const token = await new SignJWT({ role: 'authenticated', email: user.email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(secret);
    const keys = await testKeys();
    const withSecret = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      jwtSecret: HS_SECRET,
      jwks: jwksOf(keys),
    });
    expect((await withSecret.verify(token)).id).toBe(user.id);
    const without = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: jwksOf(keys) });
    await rejects(without.verify(token), 'invalid_token');
    const wrongSecret = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      jwtSecret: `${HS_SECRET}-other`,
    });
    await rejects(wrongSecret.verify(token), 'invalid_token');
  });

  it('rejects expired tokens, other issuers and audiences, and unknown keys', async () => {
    const keys = await testKeys();
    const other = await testKeys();
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: jwksOf(keys) });
    const past = Math.floor(Date.now() / 1000) - 3600;
    await rejects(
      verifier.verify(await signToken(keys, user, {}, { expiresIn: past })),
      'expired_token',
    );
    await rejects(
      verifier.verify(
        await signToken(keys, user, {}, { issuer: 'https://other.supabase.co/auth/v1' }),
      ),
      'invalid_token',
    );
    await rejects(
      verifier.verify(await signToken(keys, user, {}, { audience: 'anon' })),
      'invalid_token',
    );
    await rejects(verifier.verify(await signToken(other, user)), 'invalid_token');
  });

  it('rejects tokens that are not a signed-in user, unsigned or malformed', async () => {
    const keys = await testKeys();
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwks: jwksOf(keys) });
    await rejects(verifier.verify(await signToken(keys, user, { role: 'anon' })), 'invalid_token');
    await rejects(verifier.verify(await signToken(keys, { id: 'service' })), 'invalid_token');
    const unsigned = new UnsecuredJWT({ role: 'authenticated' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .encode();
    await rejects(verifier.verify(unsigned), 'invalid_token');
    await rejects(verifier.verify('not-a-jwt'), 'invalid_token');
    await rejects(verifier.verify(undefined), 'missing_token');
  });

  it('accepts dev login tokens only when the dev secret is configured', async () => {
    const devSecret = new TextEncoder().encode('dev-secret-for-tests-only-123456');
    const token = await signDevToken(devSecret, { id: user.id, email: 'a@example.invalid' });
    const dev = new SupabaseJwtVerifier({ devSecret });
    expect(await dev.verify(token)).toEqual({ id: user.id, email: 'a@example.invalid' });
    expect(dev.configured).toBe(true);

    // Without the dev secret the same token goes to the Supabase checks and fails them.
    const prod = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: HS_SECRET });
    await rejects(prod.verify(token), 'invalid_token');
    const none = new SupabaseJwtVerifier({});
    expect(none.configured).toBe(false);
    await rejects(none.verify(token), 'not_configured');
  });
});

describe('bearerToken', () => {
  const req = (
    headers: Record<string, string>,
    query: Record<string, string> = {},
    method = 'GET',
  ) => ({
    method,
    header: (name: string) => headers[name],
    query: (name: string) => query[name],
  });

  it('reads the Authorization header, or access_token on an event stream', () => {
    expect(bearerToken(req({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(bearerToken(req({}, { access_token: 'abc' }))).toBeUndefined();
    expect(bearerToken(req({ accept: 'text/event-stream' }, { access_token: 'abc' }))).toBe('abc');
    expect(
      bearerToken(req({ accept: 'text/event-stream' }, { access_token: 'abc' }, 'POST')),
    ).toBeUndefined();
  });
});
