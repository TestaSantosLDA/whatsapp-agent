/**
 * Local development only (ADMIN_DEV_LOGIN=true, never with NODE_ENV=production or on Cloud Run):
 * sign in to the dashboard as any team member without Supabase. The token looks like a Supabase
 * one but is signed with a local secret that the verifier accepts only while this is enabled.
 */
import { randomUUID } from 'node:crypto';
import type { DevLoginMember } from '@wa/shared';
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { teamMembers } from '../db/schema.js';
import { devLoginEnabled } from '../env.js';
import { signDevToken } from './auth.js';
import { adminError, parseBody, type AdminEnv } from './context.js';
import type { AdminDeps } from './deps.js';

const TTL_SECONDS = 12 * 3600;

export function devLoginRoutes(deps: AdminDeps) {
  const routes = new Hono<AdminEnv>();
  // Checked on every request too, not only when the routes are mounted.
  routes.use('*', async (_c, next) => {
    if (!deps.devSecret || !devLoginEnabled(deps.env))
      throw adminError(404, 'not_found', 'Not found');
    await next();
  });

  routes.get('/members', async (c) => {
    const rows = await deps.db
      .select()
      .from(teamMembers)
      .orderBy(asc(teamMembers.clientId), asc(teamMembers.role), asc(teamMembers.email));
    return c.json(
      rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        email: r.email,
        name: r.name,
        role: r.role,
        branches: r.branches,
      })) satisfies DevLoginMember[],
    );
  });

  routes.post('/login', async (c) => {
    const { memberId } = await parseBody(c, z.object({ memberId: z.uuid() }));
    const [row] = await deps.db.select().from(teamMembers).where(eq(teamMembers.id, memberId));
    if (!row) throw adminError(404, 'not_found', 'Membro não encontrado.');
    let userId = row.userId;
    if (!userId) {
      userId = randomUUID();
      await deps.db.update(teamMembers).set({ userId }).where(eq(teamMembers.id, row.id));
    }
    const token = await signDevToken(
      deps.devSecret!,
      { id: userId, email: row.email },
      TTL_SECONDS,
    );
    console.warn(`[admin] dev login as ${row.email} (${row.clientId})`);
    return c.json({ access_token: token, expires_in: TTL_SECONDS });
  });

  return routes;
}
