/**
 * The team dashboard's API (WA-022), mounted at /api/admin:
 *
 *   GET  /me                              who is signed in, and their client teams
 *   GET  /clients/:clientId/context       the member as the API scopes them (AdminContextView)
 *   *    /clients/:clientId/<feature>/... feature routes from features.ts
 *   *    /dev/...                          dev login, only with ADMIN_DEV_LOGIN outside production
 *
 * Every route but /dev needs a valid Supabase access token (401 otherwise); client routes also
 * need a team_members row for that client (403 otherwise).
 */
import type { AdminConfig, AdminContextView, AdminMe } from '@wa/shared';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { devLoginEnabled, type Env } from '../env.js';
import { AuthError, bearerToken } from './auth.js';
import { adminError, buildAdminContext, type AdminEnv } from './context.js';
import type { AdminDeps } from './deps.js';
import { devLoginRoutes } from './dev-login.js';
import { adminFeatures } from './features.js';
import { toAdminMember } from './team/service.js';

export function adminApiRoutes(deps: AdminDeps) {
  const api = new Hono<AdminEnv>();

  api.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(`[admin] ${c.req.method} ${c.req.path} failed`, error);
    return c.json({ error: 'internal_error', message: 'Ocorreu um erro. Tente de novo.' }, 500);
  });

  if (deps.devSecret && devLoginEnabled(deps.env)) api.route('/dev', devLoginRoutes(deps));

  // Authentication: a valid Supabase (or dev login) token.
  api.use('*', async (c, next) => {
    try {
      c.set('user', await deps.verifier.verify(bearerToken(c.req)));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (error.code === 'not_configured') {
        throw adminError(503, error.code, 'O início de sessão não está configurado.');
      }
      throw adminError(401, error.code, 'Inicie sessão para continuar.');
    }
    await next();
  });

  api.get('/me', async (c) => {
    const user = c.get('user');
    const memberships = await deps.team.memberships(user);
    return c.json({ user, memberships } satisfies AdminMe);
  });

  // Authorisation: a member of this client's team.
  const client = new Hono<AdminEnv>();
  client.use('*', async (c, next) => {
    const clientId = c.req.param('clientId') ?? '';
    const config = deps.clients.get(clientId);
    const member = config ? await deps.team.resolve(c.get('user'), clientId) : undefined;
    if (!config || !member) {
      throw adminError(403, 'not_a_member', 'Não faz parte da equipa deste cliente.');
    }
    c.set('admin', buildAdminContext(c.get('user'), member, config));
    await next();
  });

  client.get('/context', (c) => {
    const ctx = c.get('admin');
    const branch = (b: (typeof ctx.branches)[number]) => ({
      id: b.id,
      name: b.name,
      region: b.region,
    });
    return c.json({
      member: toAdminMember(ctx.member),
      client: { id: ctx.client.id, name: ctx.client.name, timezone: ctx.client.timezone },
      role: ctx.role,
      branches: ctx.branches.map(branch),
      allBranches: ctx.client.branches.map(branch),
    } satisfies AdminContextView);
  });

  for (const feature of adminFeatures) client.route(feature.path, feature.routes(deps));
  api.route('/clients/:clientId', client);

  api.all('*', () => {
    throw adminError(404, 'not_found', 'Not found');
  });
  return api;
}

/** GET /admin/config: read by the dashboard before sign-in. Only public values. */
export function adminConfig(env: Env, devSecret: Uint8Array | undefined): AdminConfig {
  return {
    supabaseUrl: env.SUPABASE_URL ?? null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? null,
    devLogin: Boolean(devSecret) && devLoginEnabled(env),
  };
}

/**
 * The dev login's signing secret, derived from SIMULATOR_WEBHOOK_SECRET so dev tokens survive a
 * restart of `pnpm dev`. Undefined (no dev login) unless ADMIN_DEV_LOGIN is on outside production.
 */
export function devLoginSecret(env: Env): Uint8Array | undefined {
  if (!devLoginEnabled(env)) return undefined;
  return createHash('sha256').update(`wa-admin-dev-login:${env.SIMULATOR_WEBHOOK_SECRET}`).digest();
}
