import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { InProcessQueue, type Queue } from './queue/queue.js';
import { simulatorRoutes } from './routes/simulator.js';
import { webhookRoutes } from './routes/webhook.js';
import { MessageService } from './services/messages.js';

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
  const jobDeps = { db: deps.db, clients: deps.clients, messages };
  const onFailure = onProcessConversationFailure(jobDeps);
  const queue =
    deps.queue ??
    new InProcessQueue(async (job, error) => {
      if (job.name === PROCESS_CONVERSATION)
        await onFailure(job.payload as ProcessConversationPayload, error);
      else console.error(`[queue] job ${job.name} failed`, error);
    });
  const responder = deps.responder ?? defaultResponder(deps);
  queue.register(
    PROCESS_CONVERSATION,
    processConversation({ ...jobDeps, responder, debounceMs: deps.debounceMs }),
  );

  const app = new Hono();
  if (deps.logRequests)
    app.use(
      '*',
      logger((line) => console.log(redactQuery(line))),
    );

  app.get('/health', (c) => c.json({ ok: true }));

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

  const webhook = webhookRoutes({ env: deps.env, clients: deps.clients, messages, queue });
  app.route('/webhook', webhook);
  app.route(
    '/sim',
    simulatorRoutes({
      env: deps.env,
      clients: deps.clients,
      messages,
      bus,
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

  return { app, queue, bus, messages };
}

/** The simulator stream carries the access code and the customer phone in its query string. */
export function redactQuery(line: string): string {
  return line.replace(/([?&](?:code|phone)=)[^&\s]*/g, '$1***');
}

function defaultResponder(deps: AppDeps): Responder {
  if (!deps.env.ANTHROPIC_API_KEY) {
    console.warn(
      '[agent] ANTHROPIC_API_KEY is not set: the echo test bot answers instead of Claude.',
    );
    return new EchoResponder(deps.env.PUBLIC_BASE_URL);
  }
  return new ClaudeResponder({
    db: deps.db,
    anthropic: new Anthropic({ apiKey: deps.env.ANTHROPIC_API_KEY }),
    tools: agentTools,
  });
}
