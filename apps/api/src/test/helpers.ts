import { readFileSync } from 'node:fs';
import { clientConfigSchema, type ClientConfig } from '@wa/shared';
import { createApp, type AppDeps } from '../app.js';
import { ClientRegistry } from '../clients/registry.js';
import { openDb } from '../db/index.js';
import { loadEnv } from '../env.js';

export const SECRET = 'test-simulator-secret';

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
}

export function testClient(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return clientConfigSchema.parse({
    id: 'acme',
    name: 'Acme Madeiras',
    languages: ['pt-PT', 'en'],
    default_language: 'pt-PT',
    brand_voice: 'Simpático e direto.',
    channel: {
      type: 'simulator',
      phone_number_id: 'test-phone-id',
      display_phone_number: '+351 210 000 000',
    },
    business_lines: [{ id: 'wood', name: 'Madeiras', description: 'Pavimentos e decks' }],
    branches: [
      {
        id: 'lisboa',
        name: 'Lisboa',
        region: 'Lisboa',
        address: 'Rua 1, Lisboa',
        phone: '+351 210 000 000',
        hours: { mon: ['09:00-18:00'] },
        business_lines: ['wood'],
      },
    ],
    routing: { default_branch: 'lisboa' },
    lead: { request_types: ['info', 'quote'], response_time: 'um dia útil' },
    ...overrides,
  });
}

export async function testApp(
  opts: {
    clients?: ClientConfig[];
    env?: Record<string, string>;
  } & Pick<
    AppDeps,
    | 'responder'
    | 'queue'
    | 'debounceMs'
    | 'serveSimulator'
    | 'serveAdmin'
    | 'supabaseAdmin'
    | 'jwks'
  > = {},
) {
  const env = loadEnv({
    SIMULATOR_WEBHOOK_SECRET: SECRET,
    PUBLIC_BASE_URL: 'http://test.local',
    ...opts.env,
  });
  const handle = openDb({ pgliteDir: 'memory' });
  await handle.migrate();
  const clients = new ClientRegistry(opts.clients ?? [testClient()]);
  const built = createApp({
    env,
    db: handle.db,
    clients,
    responder: opts.responder,
    queue: opts.queue,
    debounceMs: opts.debounceMs ?? 0,
    serveSimulator: opts.serveSimulator ?? false,
    serveAdmin: opts.serveAdmin ?? false,
    supabaseAdmin: opts.supabaseAdmin,
    jwks: opts.jwks,
  });
  return {
    ...built,
    env,
    clients,
    db: handle.db,
    close: async () => {
      // Let the inbox finish reacting to the last events before the database goes away.
      await built.inbox.flush();
      await handle.close();
    },
  };
}

export function postSimWebhook(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  body: string,
) {
  return app.request('/webhook/simulator', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-simulator-secret': SECRET },
    body,
  });
}
