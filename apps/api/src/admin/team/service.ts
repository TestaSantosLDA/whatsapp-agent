/** Team members per client (WA-022): who may use the dashboard, with which role and branches. */
import type {
  AdminMember,
  AdminMembership,
  InviteMemberBody,
  InviteResult,
  TeamRole,
  UpdateMemberBody,
} from '@wa/shared';
import { inviteMemberSchema } from '@wa/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { ClientRegistry } from '../../clients/registry.js';
import type { Db } from '../../db/index.js';
import { teamMembers } from '../../db/schema.js';
import type { AuthUser } from '../auth.js';
import { adminError, type TeamMemberRow } from '../context.js';
import type { SupabaseAdmin } from '../supabase-admin.js';

export function toAdminMember(row: TeamMemberRow): AdminMember {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    branches: row.branches,
    status: row.userId ? 'active' : 'invited',
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class TeamService {
  constructor(
    private readonly deps: {
      db: Db;
      clients: ClientRegistry;
      /** Undefined when SUPABASE_SERVICE_ROLE_KEY is not set: members are added without an email. */
      supabaseAdmin?: SupabaseAdmin;
      /** Where invite links land, e.g. https://<service>/admin/ */
      dashboardUrl: string;
    },
  ) {}

  list(clientId: string): Promise<TeamMemberRow[]> {
    return this.deps.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.clientId, clientId))
      .orderBy(asc(teamMembers.role), asc(teamMembers.email));
  }

  async get(clientId: string, id: string): Promise<TeamMemberRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.deps.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.clientId, clientId), eq(teamMembers.id, id)));
    return row;
  }

  /** Members of one branch (sales and admins), e.g. for lead owners and alerts (WA-024). */
  async ofBranch(clientId: string, branchId: string, role?: TeamRole): Promise<TeamMemberRow[]> {
    const rows = await this.list(clientId);
    return rows.filter((r) => r.branches.includes(branchId) && (!role || r.role === role));
  }

  /**
   * The signed-in user's membership of a client. A first sign-in links pending invites for their
   * email to their Supabase user id.
   */
  async resolve(user: AuthUser, clientId: string): Promise<TeamMemberRow | undefined> {
    const find = async () => {
      const [row] = await this.deps.db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.clientId, clientId), eq(teamMembers.userId, user.id)));
      return row;
    };
    const row = await find();
    if (row) return row;
    if ((await this.linkInvites(user)) === 0) return undefined;
    return find();
  }

  /** Every client team the user belongs to; records this as their latest sign-in. */
  async memberships(user: AuthUser, now = new Date()): Promise<AdminMembership[]> {
    await this.linkInvites(user);
    const rows = await this.deps.db
      .update(teamMembers)
      .set({ lastLoginAt: now })
      .where(eq(teamMembers.userId, user.id))
      .returning();
    return rows.flatMap((row) => {
      const client = this.deps.clients.get(row.clientId);
      return client
        ? [{ clientId: client.id, clientName: client.name, memberId: row.id, role: row.role }]
        : [];
    });
  }

  /** Links invites (rows without a user id) for the user's email to the user. */
  private async linkInvites(user: AuthUser): Promise<number> {
    if (!user.email) return 0;
    const linked = await this.deps.db
      .update(teamMembers)
      .set({ userId: user.id })
      .where(and(eq(teamMembers.email, user.email), isNull(teamMembers.userId)))
      .returning({ id: teamMembers.id });
    return linked.length;
  }

  /** Adds a member and sends Supabase's invite email. */
  async invite(
    clientId: string,
    body: InviteMemberBody,
    invitedBy: TeamMemberRow | null,
  ): Promise<InviteResult> {
    const input = inviteMemberSchema.parse(body);
    this.checkBranches(clientId, input.role, input.branches);
    const [existing] = await this.deps.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.clientId, clientId), eq(teamMembers.email, input.email)));
    if (existing) throw adminError(409, 'already_member', 'Esta pessoa já faz parte da equipa.');

    const [row] = await this.deps.db
      .insert(teamMembers)
      .values({
        clientId,
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        branches: input.branches,
        invitedBy: invitedBy?.id ?? null,
      })
      .returning();
    try {
      const invite = await this.sendInvite(row!);
      return { member: toAdminMember(row!), invite };
    } catch (error) {
      // No half-added members: without the email they could not get in anyway.
      await this.deps.db.delete(teamMembers).where(eq(teamMembers.id, row!.id));
      console.error(`[admin] invite for ${clientId} failed`, error);
      throw adminError(502, 'invite_failed', 'Não foi possível enviar o convite. Tente de novo.');
    }
  }

  /** Sends the invite email again, for someone who has not signed in yet. */
  async resendInvite(row: TeamMemberRow): Promise<InviteResult> {
    try {
      return { member: toAdminMember(row), invite: await this.sendInvite(row) };
    } catch (error) {
      console.error(`[admin] invite for ${row.clientId} failed`, error);
      throw adminError(502, 'invite_failed', 'Não foi possível enviar o convite. Tente de novo.');
    }
  }

  async update(clientId: string, id: string, body: UpdateMemberBody): Promise<TeamMemberRow> {
    const row = await this.get(clientId, id);
    if (!row) throw adminError(404, 'not_found', 'Membro não encontrado.');
    const role = body.role ?? row.role;
    const branches = body.branches ?? row.branches;
    this.checkBranches(clientId, role, branches);
    if (row.role === 'admin' && role !== 'admin') await this.keepOneAdmin(clientId, row.id);
    const [updated] = await this.deps.db
      .update(teamMembers)
      .set({
        role,
        branches,
        ...(body.name !== undefined && { name: body.name }),
      })
      .where(eq(teamMembers.id, row.id))
      .returning();
    return updated!;
  }

  async remove(clientId: string, id: string): Promise<void> {
    const row = await this.get(clientId, id);
    if (!row) throw adminError(404, 'not_found', 'Membro não encontrado.');
    if (row.role === 'admin') await this.keepOneAdmin(clientId, row.id);
    // Their Supabase account stays (it may belong to another client's team); without this row
    // every admin call answers 403 from the next request.
    await this.deps.db.delete(teamMembers).where(eq(teamMembers.id, row.id));
  }

  private async sendInvite(row: TeamMemberRow): Promise<InviteResult['invite']> {
    if (!this.deps.supabaseAdmin) return 'not_configured';
    return this.deps.supabaseAdmin.invite({
      email: row.email,
      redirectTo: this.deps.dashboardUrl,
      data: { name: row.name ?? undefined },
    });
  }

  private checkBranches(clientId: string, role: TeamRole, branches: string[]): void {
    const client = this.deps.clients.get(clientId);
    const known = new Set(client?.branches.map((b) => b.id));
    const unknown = branches.filter((b) => !known.has(b));
    if (unknown.length) {
      throw adminError(400, 'unknown_branch', `Filial desconhecida: ${unknown.join(', ')}.`);
    }
    if (role === 'sales' && branches.length === 0) {
      throw adminError(400, 'branch_required', 'Um comercial precisa de pelo menos uma filial.');
    }
  }

  private async keepOneAdmin(clientId: string, leaving: string): Promise<void> {
    const [others] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.clientId, clientId),
          eq(teamMembers.role, 'admin'),
          ne(teamMembers.id, leaving),
        ),
      );
    if (!others?.n) {
      throw adminError(409, 'last_admin', 'A equipa precisa de pelo menos um administrador.');
    }
  }

  /** Inserts members that do not exist yet (by email). For the demo seed and tests. */
  async ensure(
    clientId: string,
    members: { email: string; name?: string; role: TeamRole; branches?: string[] }[],
  ): Promise<TeamMemberRow[]> {
    if (members.length) {
      await this.deps.db
        .insert(teamMembers)
        .values(
          members.map((m) => ({
            clientId,
            email: m.email.toLowerCase(),
            name: m.name ?? null,
            role: m.role,
            branches: m.branches ?? [],
          })),
        )
        .onConflictDoNothing();
    }
    return this.deps.db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.clientId, clientId),
          inArray(
            teamMembers.email,
            members.map((m) => m.email.toLowerCase()),
          ),
        ),
      );
  }
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
