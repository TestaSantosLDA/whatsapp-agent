import type { ClientConfig, TeamRole } from '@wa/shared';

/**
 * The demo team (WA-022): one admin, and one salesperson per branch. `example.invalid` addresses
 * never receive mail; sign in as them locally with ADMIN_DEV_LOGIN, or invite real addresses from
 * the dashboard once Supabase is set up.
 */
export function demoTeam(
  client: ClientConfig,
): { email: string; name: string; role: TeamRole; branches: string[] }[] {
  return [
    {
      email: `admin.${client.id}@example.invalid`,
      name: `Administração ${client.name}`,
      role: 'admin',
      branches: [],
    },
    ...client.branches.map((branch) => ({
      email: `vendas.${branch.id}.${client.id}@example.invalid`,
      name: `Comercial ${branch.name.split(/[(—,]/)[0]!.trim()}`,
      role: 'sales' as const,
      branches: [branch.id],
    })),
  ];
}
