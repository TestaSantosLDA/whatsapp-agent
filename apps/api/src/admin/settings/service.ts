/**
 * Client settings edited in the dashboard (WA-022), stored as overrides on top of
 * clients/<id>.yaml and applied through the ClientRegistry without a restart.
 */
import {
  applyClientSettings,
  clientConfigSchema,
  clientSettingsOf,
  clientSettingsOverridesSchema,
  diffClientSettings,
  overriddenPaths,
  type AdminSettingsView,
  type ClientSettings,
} from '@wa/shared';
import { eq } from 'drizzle-orm';
import type { ClientRegistry } from '../../clients/registry.js';
import type { Db } from '../../db/index.js';
import { clientSettings, teamMembers } from '../../db/schema.js';
import { adminError } from '../context.js';

export class SettingsService {
  constructor(private readonly deps: { db: Db; clients: ClientRegistry }) {}

  /** Applies every stored override to the registry. Run once at startup, after migrations. */
  async loadAll(): Promise<void> {
    const rows = await this.deps.db.select().from(clientSettings);
    for (const row of rows) {
      if (!this.deps.clients.fileConfig(row.clientId)) continue;
      const parsed = clientSettingsOverridesSchema.safeParse(row.overrides);
      try {
        if (!parsed.success) throw parsed.error;
        this.deps.clients.setOverrides(row.clientId, parsed.data);
      } catch (error) {
        // A stored override that no longer fits the file must not stop the service.
        console.error(`[settings] ignoring saved settings for ${row.clientId}`, error);
      }
    }
  }

  async view(clientId: string): Promise<AdminSettingsView> {
    const base = this.deps.clients.fileConfig(clientId);
    const current = this.deps.clients.get(clientId);
    if (!base || !current) throw adminError(404, 'not_found', 'Cliente desconhecido.');
    const [row] = await this.deps.db
      .select({ updatedAt: clientSettings.updatedAt, by: teamMembers.email })
      .from(clientSettings)
      .leftJoin(teamMembers, eq(teamMembers.id, clientSettings.updatedBy))
      .where(eq(clientSettings.clientId, clientId));
    return {
      settings: clientSettingsOf(current),
      defaults: clientSettingsOf(base),
      overridden: overriddenPaths(this.deps.clients.settingsOverrides(clientId)),
      branches: current.branches.map((b) => ({ id: b.id, name: b.name, region: b.region })),
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.by ?? null,
    };
  }

  /**
   * Saves the edited settings: only what differs from the file is stored. Validated against the
   * client schema before anything is written; applies from the next turn on.
   */
  async save(
    clientId: string,
    edited: ClientSettings,
    memberId: string,
  ): Promise<AdminSettingsView> {
    const base = this.deps.clients.fileConfig(clientId);
    if (!base) throw adminError(404, 'not_found', 'Cliente desconhecido.');
    const ids = base.branches.map((b) => b.id).sort();
    const sent = edited.branches.map((b) => b.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(sent)) {
      throw adminError(400, 'invalid_branches', 'Envie as definições de todas as filiais.');
    }
    const overrides = diffClientSettings(base, edited);
    const merged = clientConfigSchema.safeParse(applyClientSettings(base, overrides));
    if (!merged.success) {
      const issue = merged.error.issues[0];
      throw adminError(400, 'invalid_settings', `${issue?.path.join('.')}: ${issue?.message}`);
    }
    const now = new Date();
    await this.deps.db
      .insert(clientSettings)
      .values({ clientId, overrides, updatedBy: memberId, updatedAt: now })
      .onConflictDoUpdate({
        target: clientSettings.clientId,
        set: { overrides, updatedBy: memberId, updatedAt: now },
      });
    this.deps.clients.setOverrides(clientId, overrides);
    return this.view(clientId);
  }

  /** Back to clients/<id>.yaml. */
  async reset(clientId: string): Promise<AdminSettingsView> {
    await this.deps.db.delete(clientSettings).where(eq(clientSettings.clientId, clientId));
    this.deps.clients.setOverrides(clientId, {});
    return this.view(clientId);
  }
}
