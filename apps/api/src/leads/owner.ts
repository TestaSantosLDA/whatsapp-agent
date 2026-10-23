import type { TeamRole } from '@wa/shared';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { leads, teamMembers } from '../db/schema.js';

type TeamMemberRow = typeof teamMembers.$inferSelect;

/** How the owner was chosen, recorded on the lead's `created` event. */
export type OwnerRule = 'round_robin' | 'branch_admin' | 'none';

export interface OwnerChoice {
  member: TeamMemberRow | null;
  rule: OwnerRule;
}

/** Who owns a new lead (WA-024). One place, so a per-client rule can be added later. */
export interface LeadOwnerPolicy {
  pick(lead: { clientId: string; branchId: string | null }): Promise<OwnerChoice>;
}

/** The part of TeamService the policy uses (TeamService satisfies it). */
export interface BranchTeam {
  ofBranch(clientId: string, branchId: string, role?: TeamRole): Promise<TeamMemberRow[]>;
}

/** Members of a branch straight from the database, in TeamService.ofBranch's order. */
export function dbBranchTeam(db: Db): BranchTeam {
  return {
    async ofBranch(clientId, branchId, role) {
      const rows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.clientId, clientId))
        .orderBy(asc(teamMembers.email));
      return rows.filter((r) => r.branches.includes(branchId) && (!role || r.role === role));
    },
  };
}

/**
 * Round robin among the branch's sales members, else among the branch's admins, else nobody.
 * Stateless: the next owner is the candidate whose latest lead is oldest (never assigned first),
 * so it survives restarts and adding or removing people.
 *
 * Later: a named default owner per client (from settings) is checked before the round robin.
 */
export class BranchRoundRobinPolicy implements LeadOwnerPolicy {
  private readonly team: BranchTeam;

  constructor(private readonly deps: { db: Db; team?: BranchTeam }) {
    this.team = deps.team ?? dbBranchTeam(deps.db);
  }

  async pick({
    clientId,
    branchId,
  }: {
    clientId: string;
    branchId: string | null;
  }): Promise<OwnerChoice> {
    if (!branchId) return { member: null, rule: 'none' };
    const sales = await this.team.ofBranch(clientId, branchId, 'sales');
    if (sales.length) return { member: await this.next(clientId, sales), rule: 'round_robin' };
    const admins = await this.team.ofBranch(clientId, branchId, 'admin');
    if (admins.length) return { member: await this.next(clientId, admins), rule: 'branch_admin' };
    return { member: null, rule: 'none' };
  }

  private async next(clientId: string, candidates: TeamMemberRow[]): Promise<TeamMemberRow> {
    if (candidates.length === 1) return candidates[0]!;
    const rows = await this.deps.db
      .select({
        owner: leads.ownerMemberId,
        last: max(leads.createdAt),
        n: sql<number>`count(*)::int`,
      })
      .from(leads)
      .where(
        and(
          eq(leads.clientId, clientId),
          inArray(
            leads.ownerMemberId,
            candidates.map((c) => c.id),
          ),
        ),
      )
      .groupBy(leads.ownerMemberId);
    const stats = new Map(rows.map((r) => [r.owner, r]));
    const key = (m: TeamMemberRow) => {
      const s = stats.get(m.id);
      return [s?.last ? new Date(s.last).getTime() : -1, s?.n ?? 0] as const;
    };
    // Stable sort: ties keep the team's order (by email, as TeamService lists it).
    return [...candidates].sort((a, b) => {
      const [la, na] = key(a);
      const [lb, nb] = key(b);
      return la - lb || na - nb;
    })[0]!;
  }
}
