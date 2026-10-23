import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    /** Empty = embedded PGlite database stored in PGLITE_DIR. */
    DATABASE_URL: z.string().optional(),
    PGLITE_DIR: z.string().default(`${repoRoot}data/pglite`),
    CLIENTS_DIR: z.string().default(`${repoRoot}clients`),
    SIMULATOR_WEBHOOK_SECRET: z.string().min(8),
    /** Empty = the simulator UI asks for no code. Set it on any public deploy. */
    SIMULATOR_ACCESS_CODE: z.string().optional(),
    /** Run pending migrations when the server starts. Cloud Run sets false: CI migrates. */
    MIGRATE_ON_START: booleanFlag.default(true),
    /** Sync every client's catalogue when the server starts. Cloud Run sets false: Scheduler does. */
    SYNC_ON_START: booleanFlag.default(true),
    /** Built simulator (index.html + assets) served at `/`. Missing directory = not served. */
    SIMULATOR_DIST_DIR: z.string().default(`${repoRoot}apps/simulator/dist/simulator/browser`),
    /** "inprocess" runs jobs in this process; "cloudtasks" hands them to Google Cloud Tasks. */
    QUEUE: z.enum(['inprocess', 'cloudtasks']).default('inprocess'),
    GCP_PROJECT: z.string().optional(),
    CLOUD_TASKS_LOCATION: z.string().optional(),
    CLOUD_TASKS_QUEUE: z.string().optional(),
    /** Delay before Cloud Tasks delivers a job: the debounce for a burst of customer messages. */
    CLOUD_TASKS_DELAY_MS: z.coerce.number().int().min(0).default(1500),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    /** Empty = the echo test bot answers instead of Claude. */
    ANTHROPIC_API_KEY: z.string().optional(),
    /** Public base URL of this API, used for links to its own static files. */
    PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
    /** Shared secret schedulers send as `x-jobs-secret` to /jobs/*. Empty = jobs routes disabled. */
    JOBS_SECRET: z.string().min(16).optional(),
    /** Empty = emails stop at the outbox table and the back-office panel (demo mode). */
    RESEND_API_KEY: z.string().optional(),
    /** Comma-separated addresses that receive every email instead of the client's team (demos). */
    MAIL_REDIRECT_TO: z
      .string()
      .optional()
      .transform((v) =>
        v
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.email()).optional()),
    /** Google service account key file contents (JSON), for the Google Sheets lead sink. */
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    /** Built team dashboard served at `/admin` (WA-022). Missing directory = not served. */
    ADMIN_DIST_DIR: z.string().default(`${repoRoot}apps/admin/dist/admin/browser`),
    /** Supabase project URL, e.g. https://<ref>.supabase.co. Empty = no sign-in (dev login only). */
    SUPABASE_URL: z
      .url()
      .optional()
      .transform((v) => v?.replace(/\/+$/, '')),
    /** Public "anon" (publishable) key; the dashboard signs in with it. Not a secret. */
    SUPABASE_ANON_KEY: z.string().optional(),
    /** Server-only key for the Supabase Admin API (invites). Never sent to the browser. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    /** Legacy HS256 JWT secret, for projects not yet on asymmetric signing keys. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    /**
     * Local development: sign in to the dashboard as a seeded member without Supabase. Refused
     * when NODE_ENV=production or on Cloud Run (K_SERVICE is set).
     */
    ADMIN_DEV_LOGIN: booleanFlag.default(false),
    /**
     * Where knowledge files go (WA-026): "supabase" (Storage, private bucket) or "local"
     * (FILE_STORE_DIR). Default: supabase when SUPABASE_URL and the service role key are set.
     */
    FILE_STORE: z.enum(['local', 'supabase']).optional(),
    FILE_STORE_DIR: z.string().default(`${repoRoot}data/files`),
    /** Supabase Storage bucket for knowledge files; one per deployment. Created private. */
    STORAGE_BUCKET: z.string().default('knowledge'),
    /** Model that reads uploaded documents. Default: the client's model. */
    KNOWLEDGE_MODEL: z.string().optional(),
    NODE_ENV: z.string().optional(),
    /** Set by Cloud Run on every service. */
    K_SERVICE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_DEV_LOGIN && (env.NODE_ENV === 'production' || env.K_SERVICE)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_DEV_LOGIN'],
        message: 'must not be set in production or on Cloud Run: it lets anyone sign in',
      });
    }
    if (env.FILE_STORE === 'supabase' && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FILE_STORE'],
        message: 'supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      });
    }
    if (env.QUEUE !== 'cloudtasks') return;
    for (const key of [
      'GCP_PROJECT',
      'CLOUD_TASKS_LOCATION',
      'CLOUD_TASKS_QUEUE',
      'JOBS_SECRET',
    ] as const) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'required when QUEUE=cloudtasks' });
    }
    if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'must be the public https URL of this service when QUEUE=cloudtasks',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** The dev login bypass (ADMIN_DEV_LOGIN), checked again wherever it is used. */
export function devLoginEnabled(env: Env): boolean {
  return env.ADMIN_DEV_LOGIN && env.NODE_ENV !== 'production' && !env.K_SERVICE;
}

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
