import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { syncClients } from './catalogue/sync.js';
import { loadClients } from './clients/registry.js';
import { openDb } from './db/index.js';
import { devLoginEnabled, loadDotEnv, loadEnv } from './env.js';
import { demoTeam } from './admin/team/seed.js';

loadDotEnv();
let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const clients = loadClients(env.CLIENTS_DIR);
const handle = openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
// On Cloud Run, CI applies migrations before the deploy (MIGRATE_ON_START=false), so a cold
// start does not pay for it and two instances never race on the schema.
if (env.MIGRATE_ON_START) await handle.migrate();

const { app, queue, settings, team } = createApp({
  env,
  db: handle.db,
  clients,
  logRequests: true,
});
// The team's settings from the dashboard (WA-022), on top of clients/<id>.yaml.
await settings.loadAll();
// Dev login with nobody to sign in as: add the demo team (what `pnpm db:seed` does).
if (devLoginEnabled(env)) {
  for (const client of clients.all()) {
    if ((await team.list(client.id)).length === 0) await team.ensure(client.id, demoTeam(client));
  }
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  console.log(
    `Clients: ${
      clients
        .all()
        .map((c) => c.id)
        .join(', ') || '(none)'
    }`,
  );
  console.log(`Database: ${env.DATABASE_URL ? 'Postgres' : `PGlite (${env.PGLITE_DIR})`}`);
  console.log(`Queue: ${env.QUEUE}`);
  console.log(
    `Dashboard: /admin (${env.SUPABASE_URL ? 'Supabase Auth' : 'no Supabase'}${devLoginEnabled(env) ? ', dev login' : ''})`,
  );
});

// Refresh the catalogue in the background: the API answers straight away with the last synced
// catalogue, and syncCatalogue logs its own result or failure. Off on Cloud Run, where the CPU is
// throttled outside requests and Cloud Scheduler calls /jobs/catalogue-sync every hour instead.
if (env.SYNC_ON_START) {
  void syncClients({ db: handle.db, clients: clients.all() }).catch((error: unknown) =>
    console.error('[catalogue] startup sync failed', error),
  );
}

async function shutdown() {
  server.close();
  await queue.drain();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
