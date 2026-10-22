import type { Branch, ClientConfig } from '@wa/shared';

/** Lower case, no accents, punctuation as spaces: "Loulé, FARO" → "loule faro". */
export function normalisePlace(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The branch that follows up a customer (WA-014). Business line rules come first (projects go
 * to the technical team wherever the customer is), then region rules, whose regions are matched
 * as whole words in the location the customer gave, ignoring case and accents ("Quarteira,
 * faro" matches Faro). Nothing matches → the default branch.
 */
export function routeBranch(
  client: ClientConfig,
  input: { location?: string | null; business_line?: string | null },
): Branch {
  const byId = (id: string) => client.branches.find((b) => b.id === id)!;
  const rules = client.routing.rules;

  if (input.business_line) {
    const rule = rules.find((r) => r.business_line === input.business_line);
    if (rule) return byId(rule.branch);
  }
  if (input.location) {
    const place = ` ${normalisePlace(input.location)} `;
    const rule = rules.find((r) =>
      r.regions?.some((region) => {
        const name = normalisePlace(region);
        return name !== '' && place.includes(` ${name} `);
      }),
    );
    if (rule) return byId(rule.branch);
  }
  return byId(client.routing.default_branch);
}
