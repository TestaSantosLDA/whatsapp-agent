import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { syncClients } from './catalogue/sync.js';
import { loadClients } from './clients/registry.js';
import { openDb } from './db/index.js';
import { loadDotEnv, loadEnv } from './env.js';

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
await handle.migrate();

const { app, queue } = createApp({ env, db: handle.db, clients, logRequests: true });

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
});

// Refresh the catalogue in the background: the API answers straight away with the last synced
// catalogue, and syncCatalogue logs its own result or failure.
void syncClients({ db: handle.db, clients: clients.all() }).catch((error: unknown) =>
  console.error('[catalogue] startup sync failed', error),
);

async function shutdown() {
  server.close();
  await queue.drain();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
