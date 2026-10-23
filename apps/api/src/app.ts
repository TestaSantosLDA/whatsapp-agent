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
import { mailerFromEnv, type Mailer } from './mail/mailer.js';
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
import { InboxService } from './admin/inbox/service.js';

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
  const onJobFailure = async (job: Job, error: unknown) => {
    if (job.name === PROCESS_CONVERSATION)
      await onFailure(job.payload as ProcessConversationPayload, error);
    else console.error(`[queue] job ${job.name} failed`, error);
  };
  const queue = deps.queue ?? queueFromEnv(deps.env, onJobFailure);
  // One mailer for the agent's emails and the inbox alerts (WA-023).
  const mailer = mailerFromEnv({
    clients: deps.clients.all(),
    db: deps.db,
    backoffice,
    resendApiKey: deps.env.RESEND_API_KEY,
    redirectTo: deps.env.MAIL_REDIRECT_TO,
  });
  const responder = deps.responder ?? defaultResponder(deps, backoffice, mailer);
  queue.register(
    PROCESS_CONVERSATION,
    processConversation({ ...jobDeps, responder, debounceMs: deps.debounceMs }),
  );
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
  const dashboardUrl = `${deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${ADMIN_BASE}/`;
  const team = new TeamService({
    db: deps.db,
    clients: deps.clients,
    supabaseAdmin,
    dashboardUrl,
  });
  const settings = new SettingsService({ db: deps.db, clients: deps.clients });
  const inbox = new InboxService({
    db: deps.db,
    clients: deps.clients,
    messages,
    backoffice,
    chatBus: bus,
    team,
    mailer,
    dashboardUrl,
  });
  inbox.start();

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
      runJob:
        queue instanceof CloudTasksQueue
          ? (name, payload, retryCount) => queue.run(name, payload, retryCount)
          : undefined,
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
      inbox,
      devSecret,
    }),
  );

  // Last, so every API route wins over the apps' index.html fallbacks.
  if (deps.serveAdmin ?? deps.serveSimulator ?? true) serveAdmin(app, deps.env.ADMIN_DIST_DIR);
  if (deps.serveSimulator ?? true) serveSimulator(app, deps.env.SIMULATOR_DIST_DIR);

  return { app, queue, bus, messages, backoffice, team, settings, inbox, mailer, verifier };
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

function defaultResponder(deps: AppDeps, backoffice: BackofficeService, mailer: Mailer): Responder {
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
    mailer,
  });
}
