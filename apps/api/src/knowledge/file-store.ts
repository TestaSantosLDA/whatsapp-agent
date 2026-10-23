/**
 * Where uploaded knowledge files live (WA-026): Supabase Storage in production (a private
 * bucket per deployment), a local folder in development and tests. Keys are
 * `<clientId>/<documentId>/<filename>`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface FileStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Removes the file; a missing file is not an error. */
  delete(key: string): Promise<void>;
  /** For logs: "local", "supabase". */
  readonly kind: string;
}

/** A key made safe for both stores: no path tricks, no odd characters in the file name. */
export function storageKey(clientId: string, documentId: string, filename: string): string {
  const safe =
    filename
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(-120) || 'file';
  return `${clientId}/${documentId}/${safe}`;
}

/** Files under a folder on disk. */
export class LocalFileStore implements FileStore {
  readonly kind = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid storage key ${key}`);
    return full;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** In memory, for tests. */
export class MemoryFileStore implements FileStore {
  readonly kind = 'memory';
  readonly files = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.files.set(key, { body, contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    const file = this.files.get(key);
    if (!file) throw new Error(`no file ${key}`);
    return file.body;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

/**
 * Supabase Storage over its REST API with the service role key (server only). The bucket is
 * private and created on the first upload if it does not exist.
 */
export class SupabaseStorageFileStore implements FileStore {
  readonly kind = 'supabase';
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private bucketReady = false;

  constructor(
    private readonly opts: {
      supabaseUrl: string;
      serviceRoleKey: string;
      bucket: string;
      fetch?: typeof fetch;
    },
  ) {
    this.base = `${opts.supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.serviceRoleKey}`,
      apikey: this.opts.serviceRoleKey,
      ...extra,
    };
  }

  private objectUrl(key: string): string {
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/object/${encodeURIComponent(this.opts.bucket)}/${path}`;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const upload = () =>
      this.fetch(this.objectUrl(key), {
        method: 'POST',
        headers: this.headers({ 'content-type': contentType, 'x-upsert': 'true' }),
        body: body as Uint8Array<ArrayBuffer>,
      });
    let res = await upload();
    if (!res.ok && !this.bucketReady && (await isBucketMissing(res))) {
      await this.createBucket();
      res = await upload();
    }
    if (!res.ok)
      throw new Error(`Supabase Storage upload answered ${res.status}: ${await res.text()}`);
    this.bucketReady = true;
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.fetch(this.objectUrl(key), { headers: this.headers() });
    if (!res.ok) throw new Error(`Supabase Storage download answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.fetch(`${this.base}/object/${encodeURIComponent(this.opts.bucket)}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Supabase Storage delete answered ${res.status}`);
    }
  }

  private async createBucket(): Promise<void> {
    const res = await this.fetch(`${this.base}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id: this.opts.bucket, name: this.opts.bucket, public: false }),
    });
    // 409: someone else created it meanwhile.
    if (!res.ok && res.status !== 409 && res.status !== 400) {
      throw new Error(`Supabase Storage could not create bucket: ${res.status}`);
    }
    this.bucketReady = true;
  }
}

async function isBucketMissing(res: Response): Promise<boolean> {
  if (res.status !== 404 && res.status !== 400) return false;
  const text = await res
    .clone()
    .text()
    .catch(() => '');
  return /bucket not found|bucket.*does not exist/i.test(text);
}

/**
 * FILE_STORE picks the store; unset, Supabase Storage when the project and its service role key
 * are configured, else a local folder.
 */
export function fileStoreFromEnv(env: {
  FILE_STORE?: 'local' | 'supabase';
  FILE_STORE_DIR: string;
  STORAGE_BUCKET: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): FileStore {
  const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
  const kind = env.FILE_STORE ?? (supabase ? 'supabase' : 'local');
  if (kind === 'supabase' && supabase) {
    return new SupabaseStorageFileStore({
      supabaseUrl: env.SUPABASE_URL!,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
      bucket: env.STORAGE_BUCKET,
    });
  }
  return new LocalFileStore(env.FILE_STORE_DIR);
}
