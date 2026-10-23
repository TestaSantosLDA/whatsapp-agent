import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackofficeEvent } from '@wa/shared';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { EventBus } from './bus.js';
import type { Channel } from './channels/channel.js';
import { SimulatorChannel } from './channels/simulator.js';
import { WhatsAppCloudChannel } from './channels/whatsapp-cloud.js';
import type { ClientRegistry } from './clients/registry.js';
import type { Db } from './db/index.js';
import type { Env } from './env.js';
import Anthropic from '@anthropic-ai/sdk';
import { agentTools } from './agent/registry.js';
import { ClaudeResponder } from './agent/claude-responder.js';
import { EchoResponder } from './jobs/echo-responder.js';
import {
  onProcessConversationFailure,
  PROCESS_CONVERSATION,
  processConversation,
  type ProcessConversationPayload,
  type Responder,
} from './jobs/process-conversation.js';
import { parseServiceAccount, GoogleSheetsLeadSink } from './leads/sheets.js';
import { LeadSinks, type LeadSink } from './leads/sink.js';
import { mailerFromEnv } from './mail/mailer.js';
import { CloudTasksQueue } from './queue/cloud-tasks.js';
import { InProcessQueue, type Job, type Queue } from './queue/queue.js';
import { jobsRoutes } from './routes/jobs.js';
import { simulatorRoutes } from './routes/simulator.js';
import { ADMIN_BASE, serveAdmin, serveSimulator } from './routes/spa.js';
import { webhookRoutes } from './routes/webhook.js';
import { BackofficeService } from './services/backoffice.js';
import { MessageService } from './services/messages.js';
import type { JWTVerifyGetKey } from 'jose';
import { SupabaseJwtVerifier } from './admin/auth.js';
import { adminApiRoutes, adminConfig, devLoginSecret } from './admin/router.js';
import { SettingsService } from './admin/settings/service.js';
import { SupabaseAdminApi, type SupabaseAdmin } from './admin/supabase-admin.js';
import { TeamService } from './admin/team/service.js';
import { LeadsService } from './admin/leads/service.js';
import { LeadReminders } from './leads/reminders.js';
import { KnowledgeService } from './admin/knowledge/service.js';
import { DocumentExtractor, type ParseClient } from './knowledge/extractor.js';
import { fileStoreFromEnv, type FileStore } from './knowledge/file-store.js';
import {
  onProcessDocumentFailure,
  PROCESS_DOCUMENT,
  processDocument,
  type ProcessDocumentPayload,
} from './knowledge/process.js';
import { PrivacyService } from './privacy/service.js';
import { customerSubject } from './customers/records.js';
import { CustomersService } from './admin/customers/service.js';

export interface AppDeps {
  env: Env;
  db: Db;
  clients: ClientRegistry;
  /** Defaults to the Claude agent when ANTHROPIC_API_KEY is set, else the echo test bot. */
  responder?: Responder;
  queue?: Queue;
  /** See processConversation. Tests set 0. */
  debounceMs?: number;
  logRequests?: boolean;
  /** Serve the built simulator from SIMULATOR_DIST_DIR at `/`. Default true; tests turn it off. */
  serveSimulator?: boolean;
  /** Serve the built dashboard from ADMIN_DIST_DIR at `/admin`. Default: as serveSimulator. */
  serveAdmin?: boolean;
  /** Tests: Supabase's Admin API (invites). Default: from SUPABASE_SERVICE_ROLE_KEY, if set. */
  supabaseAdmin?: SupabaseAdmin;
  /** Tests: the signing keys instead of `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. */
  jwks?: JWTVerifyGetKey;
  /** Tests: where knowledge files go (WA-026). Default: from FILE_STORE. */
  files?: FileStore;
  /**
   * Tests: the client that reads uploaded documents (a fake). Default: Anthropic when
   * ANTHROPIC_API_KEY is set; without it spreadsheets and Word files are search-only.
   */
  documentReader?: ParseClient;
}

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const contentTypes: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Wires every part together. Tests build it with an in-memory database and drain the queue. */
export function createApp(deps: AppDeps) {
  const bus = new EventBus();
  const channels = new Map<string, Channel>([
    ['simulator', new SimulatorChannel(bus)],
    ['whatsapp_cloud', new WhatsAppCloudChannel()],
  ]);
  const messages = new MessageService(deps.db, bus, channels);
  const backoffice = new BackofficeService(deps.db, new EventBus<BackofficeEvent>());
  const jobDeps = { db: deps.db, clients: deps.clients, messages, backoffice };
  const onFailure = onProcessConversationFailure(jobDeps);
  const onDocumentFailure = onProcessDocumentFailure(deps.db);
  const onJobFailure = async (job: Job, error: unknown) => {
    if (job.name === PROCESS_CONVERSATION)
      await onFailure(job.payload as ProcessConversationPayload, error);
    else if (job.name === PROCESS_DOCUMENT)
      await onDocumentFailure(job.payload as ProcessDocumentPayload, error);
    else console.error(`[queue] job ${job.name} failed`, error);
  };
  const queue = deps.queue ?? queueFromEnv(deps.env, onJobFailure);
  const responder = deps.responder ?? defaultResponder(deps, backoffice);
  queue.register(
    PROCESS_CONVERSATION,
    processConversation({ ...jobDeps, responder, debounceMs: deps.debounceMs }),
  );
  // Knowledge base (WA-026): uploaded files are read in the background.
  const files = deps.files ?? fileStoreFromEnv(deps.env);
  const documentReader =
    deps.documentReader ??
    (deps.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: deps.env.ANTHROPIC_API_KEY })
      : undefined);
  queue.register(
    PROCESS_DOCUMENT,
    processDocument({
      db: deps.db,
      clients: deps.clients,
      files,
      extractor: documentReader
        ? new DocumentExtractor({ anthropic: documentReader, model: deps.env.KNOWLEDGE_MODEL })
        : undefined,
    }),
  );
  const knowledge = new KnowledgeService({ db: deps.db, files, queue });
  // Settings changed in the dashboard: the agent rebuilds its cached system prompt.
  deps.clients.onChange((clientId) => responder.invalidate?.(clientId));

  // Team dashboard (WA-022).
  const devSecret = devLoginSecret(deps.env);
  if (devSecret) console.warn('[admin] ADMIN_DEV_LOGIN is on: anyone here can sign in as anyone.');
  const verifier = new SupabaseJwtVerifier({
    supabaseUrl: deps.env.SUPABASE_URL,
    jwtSecret: deps.env.SUPABASE_JWT_SECRET,
    jwks: deps.jwks,
    devSecret,
  });
  const supabaseAdmin =
    deps.supabaseAdmin ??
    (deps.env.SUPABASE_URL && deps.env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseAdminApi({
          supabaseUrl: deps.env.SUPABASE_URL,
          serviceRoleKey: deps.env.SUPABASE_SERVICE_ROLE_KEY,
        })
      : undefined);
  const team = new TeamService({
    db: deps.db,
    clients: deps.clients,
    supabaseAdmin,
    dashboardUrl: `${deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${ADMIN_BASE}/`,
  });
  const settings = new SettingsService({ db: deps.db, clients: deps.clients });
  // Leads pipeline (WA-024).
  const leads = new LeadsService({ db: deps.db, team, backoffice });
  const leadReminders = new LeadReminders({
    db: deps.db,
    clients: deps.clients,
    mailer: mailerFromEnv({
      db: deps.db,
      backoffice,
      resendApiKey: deps.env.RESEND_API_KEY,
      redirectTo: deps.env.MAIL_REDIRECT_TO,
    }),
    dashboardUrl: `${deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${ADMIN_BASE}`,
  });
  // Privacy tools (WA-028). Features with customer data add handlers in privacy/handlers.ts.
  // WA-027: a customer is every number of their record.
  const privacy = new PrivacyService({ db: deps.db, messages, subjects: customerSubject });
  const customers = new CustomersService({ db: deps.db, privacy });

  const app = new Hono();
  if (deps.logRequests)
    app.use(
      '*',
      logger((line) => console.log(redactQuery(line))),
    );

  // /healthz for local checks and probes; on Cloud Run use /health, because Google's front end
  // reserves some paths ending in "z" and never forwards them to the container.
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/static/:file', async (c) => {
    const file = basename(c.req.param('file'));
    const type = contentTypes[extname(file)];
    if (!type) return c.text('Not found', 404);
    try {
      const body = await readFile(join(publicDir, file));
      return c.body(body, 200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
    } catch {
      return c.text('Not found', 404);
    }
  });

  app.route(
    '/jobs',
    jobsRoutes({
      env: deps.env,
      db: deps.db,
      clients: deps.clients,
      privacy,
      runJob:
        queue instanceof CloudTasksQueue
          ? (name, payload, retryCount) => queue.run(name, payload, retryCount)
          : undefined,
      leadReminders,
    }),
  );

  const webhook = webhookRoutes({ env: deps.env, clients: deps.clients, messages, queue });
  app.route('/webhook', webhook);
  app.route(
    '/sim',
    simulatorRoutes({
      env: deps.env,
      clients: deps.clients,
      messages,
      bus,
      backoffice,
      postWebhook: (body) =>
        Promise.resolve(
          webhook.request('/simulator', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-simulator-secret': deps.env.SIMULATOR_WEBHOOK_SECRET,
            },
            body: JSON.stringify(body),
          }),
        ),
    }),
  );

  app.get(`${ADMIN_BASE}/config`, (c) => {
    c.header('cache-control', 'no-store');
    return c.json(adminConfig(deps.env, devSecret));
  });
  app.route(
    '/api/admin',
    adminApiRoutes({
      env: deps.env,
      db: deps.db,
      clients: deps.clients,
      messages,
      backoffice,
      verifier,
      team,
      settings,
      leads,
      knowledge,
      privacy,
      customers,
      devSecret,
    }),
  );

  // Last, so every API route wins over the apps' index.html fallbacks.
  if (deps.serveAdmin ?? deps.serveSimulator ?? true) serveAdmin(app, deps.env.ADMIN_DIST_DIR);
  if (deps.serveSimulator ?? true) serveSimulator(app, deps.env.SIMULATOR_DIST_DIR);

  return {
    app,
    queue,
    bus,
    messages,
    backoffice,
    team,
    settings,
    verifier,
    leads,
    leadReminders,
    knowledge,
    files,
    privacy,
    customers,
  };
}

function queueFromEnv(env: Env, onFailure: (job: Job, error: unknown) => Promise<void>): Queue {
  if (env.QUEUE === 'cloudtasks') {
    // loadEnv has checked these are set.
    return new CloudTasksQueue({
      project: env.GCP_PROJECT!,
      location: env.CLOUD_TASKS_LOCATION!,
      queue: env.CLOUD_TASKS_QUEUE!,
      targetBaseUrl: env.PUBLIC_BASE_URL,
      jobsSecret: env.JOBS_SECRET!,
      delayMs: env.CLOUD_TASKS_DELAY_MS,
      onFailure,
    });
  }
  return new InProcessQueue(onFailure);
}

/**
 * The simulator stream carries the access code and the customer phone in its query string, and
 * dashboard streams the access token.
 */
export function redactQuery(line: string): string {
  return line.replace(/([?&](?:code|phone|access_token)=)[^&\s]*/g, '$1***');
}

function defaultResponder(deps: AppDeps, backoffice: BackofficeService): Responder {
  if (!deps.env.ANTHROPIC_API_KEY) {
    console.warn(
      '[agent] ANTHROPIC_API_KEY is not set: the echo test bot answers instead of Claude.',
    );
    return new EchoResponder(deps.env.PUBLIC_BASE_URL);
  }
  const sinks: LeadSink[] = [];
  if (deps.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    sinks.push(new GoogleSheetsLeadSink(parseServiceAccount(deps.env.GOOGLE_SERVICE_ACCOUNT_JSON)));
  }
  return new ClaudeResponder({
    db: deps.db,
    anthropic: new Anthropic({ apiKey: deps.env.ANTHROPIC_API_KEY }),
    tools: agentTools,
    backoffice,
    leads: new LeadSinks({ db: deps.db, backoffice, sinks }),
    mailer: mailerFromEnv({
      clients: deps.clients.all(),
      db: deps.db,
      backoffice,
      resendApiKey: deps.env.RESEND_API_KEY,
      redirectTo: deps.env.MAIL_REDIRECT_TO,
    }),
  });
}
