import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** Empty = embedded PGlite database stored in PGLITE_DIR. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default(`${repoRoot}data/pglite`),
  CLIENTS_DIR: z.string().default(`${repoRoot}clients`),
  SIMULATOR_WEBHOOK_SECRET: z.string().min(8),
  /** Empty = the simulator UI asks for no code. Set it on any public deploy. */
  SIMULATOR_ACCESS_CODE: z.string().optional(),
  QUEUE: z.enum(['inprocess']).default('inprocess'),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** Empty = the echo test bot answers instead of Claude. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Public base URL of this API, used for links to its own static files. */
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

/** Loads the repo-root .env file into process.env, if there is one. Existing variables win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(`${repoRoot}.env`);
  } catch {
    // No .env file: rely on the real environment.
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings as unset, so `FOO=` in .env behaves like a missing variable.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment, see .env.example:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
