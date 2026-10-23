import type { BackofficeService } from '../services/backoffice.js';
import type { MessageService } from '../services/messages.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import type { Env } from '../env.js';
import type { PrivacyService } from '../privacy/service.js';
import type { SupabaseJwtVerifier } from './auth.js';
import type { LeadsService } from './leads/service.js';
import type { KnowledgeService } from './knowledge/service.js';
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
  /** WA-024: the leads pipeline. */
  leads: LeadsService;
  /** WA-026. */
  knowledge: KnowledgeService;
  /** Export, clear profile, delete, requests, retention, audit (WA-028). */
  privacy: PrivacyService;
  /** Secret of the dev login's tokens; undefined unless ADMIN_DEV_LOGIN is on (never in prod). */
  devSecret?: Uint8Array;
}
