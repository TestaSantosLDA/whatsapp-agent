import { openDb } from '../db/index.js';
import { loadDotEnv, loadEnv } from '../env.js';

loadDotEnv();
const env = loadEnv({ SIMULATOR_WEBHOOK_SECRET: 'not-needed-for-migrate', ...process.env });
const handle = openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
await handle.migrate();
await handle.close();
console.log('Migrations applied.');
