/**
 * Fire-and-forget work with retries, for side effects the customer must not wait for (emails,
 * spreadsheet rows). A task never throws into its caller: after the last attempt fails, its
 * `onFailure` runs and the error is logged. Tests call `flush()` to wait for everything.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    /** Wait before each retry; its length is the number of retries. */
    private readonly retryDelaysMs: number[] = [2_000, 10_000, 60_000],
  ) {}

  run(
    label: string,
    task: () => Promise<void>,
    onFailure?: (error: unknown) => Promise<void> | void,
  ): void {
    const done = this.attempt(label, task, onFailure).finally(() => this.pending.delete(done));
    this.pending.add(done);
  }

  /** Resolves when every task started so far (and any they start) has finished. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async attempt(
    label: string,
    task: () => Promise<void>,
    onFailure?: (error: unknown) => Promise<void> | void,
  ): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await task();
        return;
      } catch (error) {
        const delay = this.retryDelaysMs[i];
        if (delay === undefined) {
          console.error(`[background] ${label} failed after ${i + 1} attempts`, error);
          try {
            await onFailure?.(error);
          } catch (inner) {
            console.error(`[background] ${label} failure handler failed`, inner);
          }
          return;
        }
        console.warn(`[background] ${label} failed, retrying in ${delay} ms`, error);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
