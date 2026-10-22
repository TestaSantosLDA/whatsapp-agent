export interface Job<T = unknown> {
  name: string;
  payload: T;
  /** Jobs with the same key run one after another, in order. */
  key: string;
}

export type JobHandler<T = unknown> = (payload: T) => Promise<void>;

export interface Queue {
  register<T>(name: string, handler: JobHandler<T>): void;
  enqueue<T>(job: Job<T>): Promise<void>;
  /** Resolves when every job enqueued so far has finished. Used by tests and shutdown. */
  drain(): Promise<void>;
}

/** A failure that a retry cannot fix: the queue goes straight to the failure handler. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
}

/**
 * Runs jobs in this process after the HTTP response. Jobs sharing a key are chained so a
 * customer's messages are handled in order; different keys run concurrently.
 */
export class InProcessQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly onFailure: (job: Job, error: unknown) => Promise<void> | void = (job, error) =>
      console.error(`[queue] job ${job.name} (${job.key}) failed`, error),
    private readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 500 },
  ) {}

  register<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler);
  }

  async enqueue<T>(job: Job<T>): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new Error(`No handler registered for job "${job.name}"`);

    const previous = this.tails.get(job.key) ?? Promise.resolve();
    const run = previous.then(() => this.runWithRetry(job as Job, handler));
    this.tails.set(job.key, run);
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      if (this.tails.get(job.key) === run) this.tails.delete(job.key);
    });
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async runWithRetry(job: Job, handler: JobHandler): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await handler(job.payload);
        return;
      } catch (error) {
        if (attempt >= this.retry.attempts || error instanceof PermanentJobError) {
          await Promise.resolve(this.onFailure(job, error)).catch((e: unknown) =>
            console.error('[queue] failure handler threw', e),
          );
          return;
        }
        await new Promise((r) => setTimeout(r, this.retry.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
}
