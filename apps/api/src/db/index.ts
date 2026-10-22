import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Postgres when `databaseUrl` is set, otherwise an embedded PGlite database:
 * in `pgliteDir` on disk, or in memory when `pgliteDir` is "memory".
 */
export function openDb(opts: { databaseUrl?: string; pgliteDir?: string }): DbHandle {
  if (opts.databaseUrl) {
    // prepare: false because Supabase's transaction pooler (port 6543) cannot keep prepared
    // statements across transactions; it costs nothing measurable on a direct connection.
    const sqlClient = postgres(opts.databaseUrl, { max: 5, prepare: false });
    const db = drizzlePostgres(sqlClient, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migratePostgres(db, { migrationsFolder }),
      close: () => sqlClient.end(),
    };
  }
  const dir = opts.pgliteDir ?? 'memory';
  if (dir !== 'memory') mkdirSync(dir, { recursive: true });
  const client = dir === 'memory' ? new PGlite() : new PGlite(dir);
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}

export { schema };
