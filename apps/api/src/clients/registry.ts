import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientConfigSchema, type ClientConfig } from '@wa/shared';
import { parse } from 'yaml';

export class ClientRegistry {
  private readonly byId = new Map<string, ClientConfig>();
  private readonly byPhoneNumberId = new Map<string, ClientConfig>();

  constructor(clients: ClientConfig[]) {
    for (const client of clients) {
      if (this.byId.has(client.id)) throw new Error(`Duplicate client id "${client.id}"`);
      const phoneId = client.channel.phone_number_id;
      if (this.byPhoneNumberId.has(phoneId)) {
        throw new Error(`Duplicate phone_number_id "${phoneId}" (client "${client.id}")`);
      }
      this.byId.set(client.id, client);
      this.byPhoneNumberId.set(phoneId, client);
    }
  }

  get(id: string): ClientConfig | undefined {
    return this.byId.get(id);
  }

  getByPhoneNumberId(phoneNumberId: string): ClientConfig | undefined {
    return this.byPhoneNumberId.get(phoneNumberId);
  }

  all(): ClientConfig[] {
    return [...this.byId.values()];
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
  ].filter((id) => !branchIds.has(id));
  if (badRefs.length) {
    throw new Error(
      `Invalid client config ${source}:\n  - routing: unknown branch ${badRefs.join(', ')}`,
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
