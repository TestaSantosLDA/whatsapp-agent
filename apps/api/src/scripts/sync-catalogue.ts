/**
 * Syncs the catalogue of every client that has one, or of the clients named as arguments:
 * `pnpm sync:catalogue` or `pnpm sync:catalogue jular`. Exits 1 if any sync failed.
 */
import { syncClients } from '../catalogue/sync.js';
import { loadClients } from '../clients/registry.js';
import { openDb } from '../db/index.js';
import { loadDotEnv, loadEnv } from '../env.js';

loadDotEnv();
const env = loadEnv({ SIMULATOR_WEBHOOK_SECRET: 'not-needed-for-sync', ...process.env });
const registry = loadClients(env.CLIENTS_DIR);
const ids = process.argv.slice(2).filter((a) => a !== '--');
const unknown = ids.filter((id) => !registry.get(id));
if (unknown.length) {
  console.error(`Unknown client(s): ${unknown.join(', ')}`);
  process.exit(1);
}
const clients = ids.length ? ids.map((id) => registry.get(id)!) : registry.all();

const handle = openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
await handle.migrate();
const results = await syncClients({ db: handle.db, clients });
await handle.close();
if (results.length === 0) console.log('No client has a catalogue to sync.');
process.exit(results.every((r) => r.ok) ? 0 : 1);
