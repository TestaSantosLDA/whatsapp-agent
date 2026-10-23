/**
 * What every client-scoped admin route knows about the caller (WA-022), and the helpers feature
 * routes use to scope their queries. See "Admin dashboard" in docs/architecture.md.
 */
import type { Branch, ClientConfig, TeamRole } from '@wa/shared';
import { inArray, sql, type Column, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { teamMembers } from '../db/schema.js';
import type { AuthUser } from './auth.js';

export type TeamMemberRow = typeof teamMembers.$inferSelect;

export interface AdminContext {
  /** The Supabase user behind the token. */
  user: AuthUser;
  /** Their row in team_members for this client. */
  member: TeamMemberRow;
  /** The client's config in effect (file plus settings). */
  client: ClientConfig;
  role: TeamRole;
  /** Branches this member works with: every branch for admins, their own for sales. */
  branches: Branch[];
  /** Ids of `branches`. */
  branchIds: string[];
}

/** Hono variables on admin routes: `user` once the token is verified, `admin` on client routes. */
export interface AdminEnv {
  Variables: {
    user: AuthUser;
    admin: AdminContext;
  };
}

export function buildAdminContext(
  user: AuthUser,
  member: TeamMemberRow,
  client: ClientConfig,
): AdminContext {
  const branches =
    member.role === 'admin'
      ? client.branches
      : client.branches.filter((b) => member.branches.includes(b.id));
  return {
    user,
    member,
    client,
    role: member.role,
    branches,
    branchIds: branches.map((b) => b.id),
  };
}

/** A JSON error the dashboard can show: `{ error: code, message }`. */
export function adminError(status: ContentfulStatusCode, code: string, message: string) {
  return new HTTPException(status, {
    res: Response.json({ error: code, message }, { status }),
  });
}

export const isAdmin = (ctx: AdminContext) => ctx.role === 'admin';

/** Whether the member may see a record of this branch. Records without a branch: admins only. */
export function canSeeBranch(ctx: AdminContext, branchId: string | null | undefined): boolean {
  if (isAdmin(ctx)) return true;
  return branchId != null && ctx.branchIds.includes(branchId);
}

/** Throws 403 unless the member may see records of this branch. */
export function assertBranch(ctx: AdminContext, branchId: string | null | undefined): void {
  if (!canSeeBranch(ctx, branchId)) {
    throw adminError(403, 'forbidden_branch', 'Esta filial não está atribuída a si.');
  }
}

/**
 * A where-condition limiting rows to the member's branches, for a query that already filters on
 * `client_id`: `undefined` (no limit) for admins, `branch_id IN (...)` for sales. Combine with
 * `and(eq(table.clientId, ctx.client.id), branchFilter(ctx, table.branchId))`.
 */
export function branchFilter(ctx: AdminContext, column: Column): SQL | undefined {
  if (isAdmin(ctx)) return undefined;
  if (ctx.branchIds.length === 0) return sql`false`;
  return inArray(column, ctx.branchIds);
}

/** The JSON body parsed with a Zod schema, or a 400 with the first problem. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw adminError(400, 'invalid_body', `${where}${issue?.message ?? 'invalid body'}`);
  }
  return parsed.data;
}

/** Middleware: 403 unless the member is an admin of this client. */
export const requireAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  if (!isAdmin(c.get('admin'))) {
    throw adminError(403, 'admin_only', 'Só um administrador pode fazer isto.');
  }
  await next();
});
