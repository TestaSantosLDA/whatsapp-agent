import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyClientSettings,
  clientConfigSchema,
  coreLeadKeys,
  type ClientConfig,
  type ClientSettingsOverrides,
} from '@wa/shared';
import { parse } from 'yaml';

/**
 * Every client's config: clients/<id>.yaml with the team's settings from the dashboard applied
 * on top (WA-022). `get` always returns the merged config, so a settings change applies to the
 * next turn, lead or email without a restart. Listeners hear about every change (the agent
 * rebuilds its cached system prompt).
 *
 * Overrides live in memory once loaded: the service runs one instance (docs/deploy.md). A second
 * instance would need to reload them (e.g. Postgres LISTEN/NOTIFY) before scaling out.
 */
export class ClientRegistry {
  private readonly base = new Map<string, ClientConfig>();
  private readonly merged = new Map<string, ClientConfig>();
  private readonly overrides = new Map<string, ClientSettingsOverrides>();
  private readonly byPhoneNumberId = new Map<string, string>();
  private readonly listeners = new Set<(clientId: string) => void>();

  constructor(clients: ClientConfig[]) {
    for (const client of clients) {
      if (this.base.has(client.id)) throw new Error(`Duplicate client id "${client.id}"`);
      const phoneId = client.channel.phone_number_id;
      if (this.byPhoneNumberId.has(phoneId)) {
        throw new Error(`Duplicate phone_number_id "${phoneId}" (client "${client.id}")`);
      }
      this.base.set(client.id, client);
      this.merged.set(client.id, client);
      this.byPhoneNumberId.set(phoneId, client.id);
    }
  }

  /** The config in effect: the file plus the team's settings. */
  get(id: string): ClientConfig | undefined {
    return this.merged.get(id);
  }

  getByPhoneNumberId(phoneNumberId: string): ClientConfig | undefined {
    const id = this.byPhoneNumberId.get(phoneNumberId);
    return id === undefined ? undefined : this.merged.get(id);
  }

  all(): ClientConfig[] {
    return [...this.merged.values()];
  }

  /** clients/<id>.yaml as loaded, without the team's settings. */
  fileConfig(id: string): ClientConfig | undefined {
    return this.base.get(id);
  }

  settingsOverrides(id: string): ClientSettingsOverrides {
    return this.overrides.get(id) ?? {};
  }

  /**
   * Replaces a client's overrides. The merged config is validated with the client schema first;
   * an invalid result throws and changes nothing.
   */
  setOverrides(id: string, overrides: ClientSettingsOverrides): ClientConfig {
    const base = this.base.get(id);
    if (!base) throw new Error(`Unknown client "${id}"`);
    const merged = clientConfigSchema.parse(applyClientSettings(base, overrides));
    this.overrides.set(id, overrides);
    this.merged.set(id, merged);
    for (const listener of this.listeners) listener(id);
    return merged;
  }

  /** Called with the client id after every settings change. Returns an unsubscribe function. */
  onChange(listener: (clientId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Parses and validates one client YAML document. `source` names the file in error messages. */
export function parseClientConfig(yamlText: string, source: string): ClientConfig {
  const parsed = clientConfigSchema.safeParse(parse(yamlText));
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid client config ${source}:\n${lines.join('\n')}`);
  }
  const config = parsed.data;
  const branchIds = new Set(config.branches.map((b) => b.id));
  const badRefs = [
    config.routing.default_branch,
    ...config.routing.rules.map((r) => r.branch),
    ...(config.lead.order_branch ? [config.lead.order_branch] : []),
  ].filter((id) => !branchIds.has(id));
  if (badRefs.length) {
    throw new Error(
      `Invalid client config ${source}:\n  - routing: unknown branch ${badRefs.join(', ')}`,
    );
  }
  const lineIds = new Set(config.business_lines.map((l) => l.id));
  const skillErrors = config.skills.flatMap((skill, i) => [
    ...(skill.business_line && !lineIds.has(skill.business_line)
      ? [`skills.${i}.business_line: unknown business line ${skill.business_line}`]
      : []),
    ...skill.lead_fields
      .filter((f) => coreLeadKeys.includes(f.id))
      .map((f) => `skills.${i}.lead_fields: ${f.id} is a core lead field; use another id`),
  ]);
  if (skillErrors.length) {
    throw new Error(
      `Invalid client config ${source}:\n${skillErrors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
  if (config.lead.sinks.includes('sheets') && !config.lead.sheets) {
    throw new Error(
      `Invalid client config ${source}:\n  - lead.sheets: required when lead.sinks includes sheets`,
    );
  }
  return config;
}

export function loadClients(dir: string): ClientRegistry {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const clients = files.map((f) => {
    const path = join(dir, f);
    return parseClientConfig(readFileSync(path, 'utf8'), path);
  });
  return new ClientRegistry(clients);
}
