import type { BackofficeService } from '../services/backoffice.js';
import type { MessageService } from '../services/messages.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import type { Env } from '../env.js';
import type { SupabaseJwtVerifier } from './auth.js';
import type { InboxService } from './inbox/service.js';
import type { SettingsService } from './settings/service.js';
import type { TeamService } from './team/service.js';

/**
 * What admin feature routes get (WA-022). Add the services a new feature needs here, built once
 * in createApp, rather than constructing them inside a route.
 */
export interface AdminDeps {
  env: Env;
  db: Db;
  clients: ClientRegistry;
  messages: MessageService;
  backoffice: BackofficeService;
  verifier: SupabaseJwtVerifier;
  team: TeamService;
  settings: SettingsService;
  /** WA-023. */
  inbox: InboxService;
  /** Secret of the dev login's tokens; undefined unless ADMIN_DEV_LOGIN is on (never in prod). */
  devSecret?: Uint8Array;
}
