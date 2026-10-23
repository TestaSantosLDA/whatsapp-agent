/**
 * Verifies the Supabase Auth access tokens the dashboard sends (WA-022).
 *
 * Supabase signs with asymmetric keys (ES256 or RS256) published at
 * `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`; older projects sign with a shared HS256 secret
 * (SUPABASE_JWT_SECRET). Both are accepted. The key set is fetched once and cached, and fetched
 * again when a token names a key it has not seen (Supabase rotating its keys).
 */
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export interface AuthUser {
  /** Supabase Auth user id (`sub`). */
  id: string;
  email: string | null;
}

export type AuthErrorCode = 'missing_token' | 'invalid_token' | 'expired_token' | 'not_configured';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Supabase puts every signed-in user in the `authenticated` audience and role. */
const AUDIENCE = 'authenticated';
const ASYMMETRIC = ['ES256', 'RS256', 'EdDSA'];
/** Tokens minted by the dev login (ADMIN_DEV_LOGIN) carry this issuer and key id. */
export const DEV_ISSUER = 'wa-admin-dev-login';
const DEV_KID = 'dev-login';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JwtVerifierOptions {
  supabaseUrl?: string;
  /** Legacy HS256 secret (Supabase → Project settings → JWT keys → Legacy JWT secret). */
  jwtSecret?: string;
  /** Tests: a key set to use instead of fetching the project's JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Tests: the fetch used for the JWKS. */
  fetch?: typeof fetch;
  /** Secret of the dev login's own tokens; set only when the dev login is enabled. */
  devSecret?: Uint8Array;
  /** Tests: the clock. */
  now?: () => Date;
}

export class SupabaseJwtVerifier {
  readonly issuer: string | undefined;
  private readonly jwks: JWTVerifyGetKey | undefined;
  private readonly secret: Uint8Array | undefined;

  constructor(private readonly opts: JwtVerifierOptions) {
    this.issuer = opts.supabaseUrl ? `${opts.supabaseUrl.replace(/\/+$/, '')}/auth/v1` : undefined;
    this.secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : undefined;
    const fetchFn = opts.fetch;
    this.jwks =
      opts.jwks ??
      (this.issuer
        ? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), {
            // Keys rarely change: keep them 10 minutes, and refetch at most every 30 s when a
            // token names an unknown key.
            cacheMaxAge: 10 * 60_000,
            cooldownDuration: 30_000,
            timeoutDuration: 5_000,
            ...(fetchFn && {
              [customFetch]: (url: string, init: RequestInit) => fetchFn(url, init),
            }),
          })
        : undefined);
  }

  /** Whether any kind of sign-in can succeed. */
  get configured(): boolean {
    return Boolean(this.issuer || this.opts.devSecret);
  }

  async verify(token: string | undefined): Promise<AuthUser> {
    if (!token) throw new AuthError('missing_token', 'Sign in first.');
    let alg: string | undefined;
    let kid: string | undefined;
    try {
      ({ alg, kid } = decodeProtectedHeader(token));
    } catch {
      throw new AuthError('invalid_token', 'Malformed token.');
    }
    const currentDate = this.opts.now?.();

    try {
      let payload: JWTPayload;
      if (this.opts.devSecret && alg === 'HS256' && kid === DEV_KID) {
        ({ payload } = await jwtVerify(token, this.opts.devSecret, {
          issuer: DEV_ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
          requiredClaims: ['sub', 'exp'],
          currentDate,
        }));
      } else {
        if (!this.issuer) throw new AuthError('not_configured', 'Sign-in is not configured.');
        const common = {
          issuer: this.issuer,
          audience: AUDIENCE,
          requiredClaims: ['sub', 'exp'],
          clockTolerance: 30,
          currentDate,
        };
        if (alg === 'HS256') {
          if (!this.secret) throw new AuthError('invalid_token', 'HS256 tokens are not accepted.');
          ({ payload } = await jwtVerify(token, this.secret, { ...common, algorithms: ['HS256'] }));
        } else {
          ({ payload } = await jwtVerify(token, this.jwks!, { ...common, algorithms: ASYMMETRIC }));
        }
      }
      if (payload.role !== AUDIENCE || !uuidPattern.test(payload.sub ?? '')) {
        throw new AuthError('invalid_token', 'Not a signed-in user.');
      }
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      return { id: payload.sub!.toLowerCase(), email: email || null };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof errors.JWTExpired)
        throw new AuthError('expired_token', 'Token expired.');
      if (error instanceof errors.JOSEError) {
        throw new AuthError('invalid_token', `Invalid token (${error.code}).`);
      }
      throw error;
    }
  }
}

/** A token for the dev login, shaped like Supabase's (same audience, role and claims). */
export function signDevToken(
  secret: Uint8Array,
  user: { id: string; email: string },
  ttlSeconds = 12 * 3600,
): Promise<string> {
  return new SignJWT({ email: user.email, role: AUDIENCE })
    .setProtectedHeader({ alg: 'HS256', kid: DEV_KID, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(DEV_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

/** `Authorization: Bearer <token>`, or `?access_token=` for EventSource streams (no headers). */
export function bearerToken(req: {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
  method: string;
}): string | undefined {
  const header = req.header('authorization');
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (match) return match[1];
  if (req.method === 'GET' && (req.header('accept') ?? '').includes('text/event-stream')) {
    return req.query('access_token') || undefined;
  }
  return undefined;
}
