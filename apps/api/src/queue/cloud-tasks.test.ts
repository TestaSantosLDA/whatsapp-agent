import { describe, expect, it, vi } from 'vitest';
import { CloudTasksQueue, metadataTokenProvider } from './cloud-tasks.js';
import { PermanentJobError } from './queue.js';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? '{}' : 'quota exceeded', { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function makeQueue(overrides: Partial<ConstructorParameters<typeof CloudTasksQueue>[0]> = {}) {
  return new CloudTasksQueue({
    project: 'wa-demo',
    location: 'europe-west1',
    queue: 'conversations',
    targetBaseUrl: 'https://wa-api-123.europe-west1.run.app/',
    jobsSecret: 'jobs-secret-1234567890',
    delayMs: 1500,
    getAccessToken: async () => 'token-abc',
    now: () => NOW,
    retryDelaysMs: [0, 0],
    ...overrides,
  });
}

describe('CloudTasksQueue.enqueue', () => {
  it('creates an HTTP task to /jobs/run/<name>, scheduled after the debounce delay', async () => {
    const { fn, calls } = fakeFetch();
    const queue = makeQueue({ fetch: fn });
    queue.register('process-conversation', async () => {});
    await queue.enqueue({
      name: 'process-conversation',
      key: 'conv-1',
      payload: { clientId: 'acme', conversationId: 'conv-1' },
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://cloudtasks.googleapis.com/v2/projects/wa-demo/locations/europe-west1/queues/conversations/tasks',
    );
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-abc');
    const { task } = JSON.parse(init.body as string);
    expect(task.scheduleTime).toBe('2026-10-22T10:00:01.500Z');
    expect(task.httpRequest.url).toBe(
      'https://wa-api-123.europe-west1.run.app/jobs/run/process-conversation',
    );
    expect(task.httpRequest.httpMethod).toBe('POST');
    expect(task.httpRequest.headers['x-jobs-secret']).toBe('jobs-secret-1234567890');
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual({
      clientId: 'acme',
      conversationId: 'conv-1',
    });
  });

  it('retries createTask, so a passing API error does not lose the reply', async () => {
    const ok = fakeFetch(200);
    let calls = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) =>
      ++calls === 1
        ? new Response('unavailable', { status: 503 })
        : ok.fn(url, init)) as typeof fetch;
    const queue = makeQueue({ fetch: flaky });
    queue.register('work', async () => {});
    await queue.enqueue({ name: 'work', key: 'a', payload: {} });
    expect(calls).toBe(2);
    expect(ok.calls).toHaveLength(1);
  });

  it('throws when the API keeps refusing the task, and refuses unknown jobs', async () => {
    const refused = fakeFetch(429);
    const queue = makeQueue({ fetch: refused.fn });
    queue.register('work', async () => {});
    await expect(queue.enqueue({ name: 'work', key: 'a', payload: {} })).rejects.toThrow(
      /429 quota exceeded/,
    );
    expect(refused.calls).toHaveLength(3);
    await expect(queue.enqueue({ name: 'nope', key: 'a', payload: {} })).rejects.toThrow(
      /No handler/,
    );
    await queue.drain();
  });
});

describe('CloudTasksQueue.run', () => {
  it('runs the handler with the payload', async () => {
    const queue = makeQueue({ fetch: fakeFetch().fn });
    const handler = vi.fn(async () => {});
    queue.register('work', handler);
    expect(await queue.run('work', { a: 1 }, 0)).toBe('done');
    expect(handler).toHaveBeenCalledWith({ a: 1 });
    expect(await queue.run('nope', {}, 0)).toBe('unknown-job');
  });

  it('asks for a retry until the last attempt, then calls the failure handler once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFailure = vi.fn();
    const queue = makeQueue({ fetch: fakeFetch().fn, maxAttempts: 3, onFailure });
    queue.register('work', async () => {
      throw new Error('boom');
    });
    expect(await queue.run('work', { a: 1 }, 0)).toBe('retry');
    expect(await queue.run('work', { a: 1 }, 1)).toBe('retry');
    expect(onFailure).not.toHaveBeenCalled();
    expect(await queue.run('work', { a: 1 }, 2)).toBe('done');
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]![0]).toMatchObject({ name: 'work', payload: { a: 1 } });
    vi.restoreAllMocks();
  });

  it('does not retry a PermanentJobError', async () => {
    const onFailure = vi.fn();
    const queue = makeQueue({ fetch: fakeFetch().fn, onFailure });
    queue.register('work', async () => {
      throw new PermanentJobError('bad payload');
    });
    expect(await queue.run('work', {}, 0)).toBe('done');
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

describe('metadataTokenProvider', () => {
  it('asks the metadata server once and caches the token until shortly before expiry', async () => {
    let now = NOW;
    const fn = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: `t${fn.mock.calls.length}`, expires_in: 3600 }),
        ),
    );
    const token = metadataTokenProvider(fn as unknown as typeof fetch, () => now);
    expect(await token()).toBe('t1');
    expect(await token()).toBe('t1');
    expect(fn).toHaveBeenCalledOnce();
    expect(String(fn.mock.calls[0]![0])).toContain('/service-accounts/default/token');
    expect(fn.mock.calls[0]![1]!.headers).toEqual({ 'metadata-flavor': 'Google' });
    now += 3541 * 1000;
    expect(await token()).toBe('t2');
  });
});
