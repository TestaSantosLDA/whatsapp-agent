import { PermanentJobError, type Job, type JobHandler, type Queue } from './queue.js';

type FetchFn = typeof fetch;

export interface CloudTasksOptions {
  project: string;
  location: string;
  queue: string;
  /** Public https URL of this service. Tasks are delivered to `<base>/jobs/run/<job name>`. */
  targetBaseUrl: string;
  /** Sent as `x-jobs-secret`, the same check as every other /jobs route. */
  jobsSecret: string;
  /** Delay before delivery (scheduleTime). Messages a customer sends meanwhile join the turn. */
  delayMs?: number;
  /** Attempts before the failure handler runs. Keep it equal to the queue's max-attempts. */
  maxAttempts?: number;
  onFailure?: (job: Job, error: unknown) => Promise<void> | void;
  fetch?: FetchFn;
  /** OAuth access token for the Cloud Tasks API. Defaults to the metadata server (Cloud Run). */
  getAccessToken?: () => Promise<string>;
  now?: () => number;
  /**
   * Waits between createTask attempts. The customer's message is already stored when enqueue
   * runs, and Meta's redelivery is dropped as a duplicate, so a lost task means no reply at all.
   */
  retryDelaysMs?: number[];
}

/** Outcome of one delivery: `retry` makes the route answer 500 so Cloud Tasks tries again. */
export type RunResult = 'done' | 'retry' | 'unknown-job';

/**
 * Hands jobs to Google Cloud Tasks, which POSTs each one back to this service's /jobs/run route.
 *
 * Why not the in-process queue on Cloud Run: with request-based billing the CPU is throttled as
 * soon as the HTTP response is sent, and an instance scaled to zero takes its in-memory jobs with
 * it. A job handled inside a Cloud Tasks request runs with full CPU, survives scale-down, and is
 * retried by Cloud Tasks if the instance dies.
 *
 * Order: the queue must be created with max-concurrent-dispatches 1 (see docs/deploy.md), so a
 * customer's turns never run concurrently. That also serialises different customers, which is
 * fine at demo volume.
 */
export class CloudTasksQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly fetch: FetchFn;
  private readonly getAccessToken: () => Promise<string>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: CloudTasksOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.getAccessToken = opts.getAccessToken ?? metadataTokenProvider(this.fetch, this.now);
  }

  register<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler);
  }

  async enqueue<T>(job: Job<T>): Promise<void> {
    if (!this.handlers.has(job.name))
      throw new Error(`No handler registered for job "${job.name}"`);
    const created = this.createTaskWithRetries(job);
    this.pending.add(created);
    try {
      await created;
    } finally {
      this.pending.delete(created);
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Runs one delivery. `retryCount` is Cloud Tasks' X-CloudTasks-TaskRetryCount (0 at first). */
  async run(name: string, payload: unknown, retryCount: number): Promise<RunResult> {
    const handler = this.handlers.get(name);
    if (!handler) return 'unknown-job';
    try {
      await handler(payload);
      return 'done';
    } catch (error) {
      if (retryCount + 1 < this.maxAttempts && !(error instanceof PermanentJobError)) {
        console.error(`[queue] job ${name} attempt ${retryCount + 1} failed, will retry`, error);
        return 'retry';
      }
      const onFailure =
        this.opts.onFailure ??
        ((job: Job, e: unknown) => console.error(`[queue] job ${job.name} failed`, e));
      await Promise.resolve(onFailure({ name, payload, key: '' }, error)).catch((e: unknown) =>
        console.error('[queue] failure handler threw', e),
      );
      return 'done';
    }
  }

  private async createTaskWithRetries(job: Job): Promise<void> {
    const delays = this.opts.retryDelaysMs ?? [500, 2000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.createTask(job);
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined) throw error;
        console.warn(`[queue] createTask attempt ${attempt + 1} failed, retrying`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async createTask(job: Job): Promise<void> {
    const { project, location, queue, targetBaseUrl, jobsSecret } = this.opts;
    const parent = `projects/${project}/locations/${location}/queues/${queue}`;
    const url = `${targetBaseUrl.replace(/\/$/, '')}/jobs/run/${encodeURIComponent(job.name)}`;
    const scheduleTime = new Date(this.now() + (this.opts.delayMs ?? 0)).toISOString();
    const body = {
      task: {
        scheduleTime,
        httpRequest: {
          url,
          httpMethod: 'POST',
          headers: { 'content-type': 'application/json', 'x-jobs-secret': jobsSecret },
          body: Buffer.from(JSON.stringify(job.payload)).toString('base64'),
        },
      },
    };
    const token = await this.getAccessToken();
    const res = await this.fetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloud Tasks createTask failed: ${res.status} ${detail.slice(0, 500)}`);
    }
  }
}

/** Access token of the service's own account, from the metadata server, cached until expiry. */
export function metadataTokenProvider(fetchFn: FetchFn = fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAt: number } | undefined;
  return async (): Promise<string> => {
    if (cached && cached.expiresAt > now()) return cached.token;
    const res = await fetchFn(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'metadata-flavor': 'Google' } },
    );
    if (!res.ok) throw new Error(`Metadata server token request failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh a minute early so a token never expires mid-request.
    cached = { token: json.access_token, expiresAt: now() + (json.expires_in - 60) * 1000 };
    return cached.token;
  };
}
