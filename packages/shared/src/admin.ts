/**
 * The team dashboard's API (WA-022): request bodies and the JSON the API answers with. Feature
 * tickets (WA-023 to WA-029) add their own types next to these, one file per feature if they grow.
 */
import { z } from 'zod';
import type { ClientSettings } from './settings.js';

export const teamRoleSchema = z.enum(['admin', 'sales']);
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** GET /admin/config: what the dashboard needs before anyone signs in. Not secret. */
export interface AdminConfig {
  /** Empty when Supabase Auth is not configured (local development without it). */
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** Local development only: sign in as a seeded member without Supabase (ADMIN_DEV_LOGIN). */
  devLogin: boolean;
}

export interface AdminMember {
  id: string;
  email: string;
  name: string | null;
  role: TeamRole;
  /** Branch ids. For sales: the branches they see. For admins: the branches they are alerted for. */
  branches: string[];
  /** `invited` until the person signs in for the first time. */
  status: 'invited' | 'active';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminMembership {
  clientId: string;
  clientName: string;
  memberId: string;
  role: TeamRole;
}

/** GET /api/admin/me: who is signed in and which clients' teams they belong to. */
export interface AdminMe {
  user: { id: string; email: string | null };
  memberships: AdminMembership[];
}

export interface AdminBranch {
  id: string;
  name: string;
  region: string;
}

/** GET /api/admin/clients/:clientId/context: the signed-in member as the API scopes them. */
export interface AdminContextView {
  member: AdminMember;
  client: { id: string; name: string; timezone: string };
  role: TeamRole;
  /** Branches this member works with: every branch for admins, their own for sales. */
  branches: AdminBranch[];
  /** Every branch of the client (for pickers, e.g. when inviting a colleague). */
  allBranches: AdminBranch[];
}

export const inviteMemberSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().min(1).max(120).optional(),
  role: teamRoleSchema,
  branches: z.array(z.string()).max(50).default([]),
});
export type InviteMemberBody = z.input<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable(),
    role: teamRoleSchema,
    branches: z.array(z.string()).max(50),
  })
  .partial();
export type UpdateMemberBody = z.infer<typeof updateMemberSchema>;

/** What happened to the Supabase invite email when a member was added. */
export type InviteStatus = 'sent' | 'already_registered' | 'not_configured';

export interface InviteResult {
  member: AdminMember;
  invite: InviteStatus;
}

/** GET and PUT /api/admin/clients/:clientId/settings. */
export interface AdminSettingsView {
  /** What applies now (the file plus the team's changes). */
  settings: ClientSettings;
  /** What clients/<id>.yaml says, for "reset to default". */
  defaults: ClientSettings;
  /** Paths the team changed, e.g. `branches.maia.lead_emails`. */
  overridden: string[];
  branches: AdminBranch[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/admin/dev/members (ADMIN_DEV_LOGIN only). */
export interface DevLoginMember {
  id: string;
  clientId: string;
  email: string;
  name: string | null;
  role: TeamRole;
  branches: string[];
}
