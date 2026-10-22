import { describe, expect, it, vi } from 'vitest';
import { InProcessQueue } from './queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('InProcessQueue', () => {
  it('runs jobs with the same key one after another, in order', async () => {
    const log: string[] = [];
    const queue = new InProcessQueue();
    queue.register<{ id: string; ms: number }>('work', async ({ id, ms }) => {
      log.push(`start ${id}`);
      await sleep(ms);
      log.push(`end ${id}`);
    });
    await queue.enqueue({ name: 'work', key: 'a', payload: { id: '1', ms: 30 } });
    await queue.enqueue({ name: 'work', key: 'a', payload: { id: '2', ms: 1 } });
    await queue.drain();
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('runs different keys concurrently', async () => {
    const log: string[] = [];
    const queue = new InProcessQueue();
    queue.register<{ id: string; ms: number }>('work', async ({ id, ms }) => {
      log.push(`start ${id}`);
      await sleep(ms);
      log.push(`end ${id}`);
    });
    await queue.enqueue({ name: 'work', key: 'a', payload: { id: '1', ms: 30 } });
    await queue.enqueue({ name: 'work', key: 'b', payload: { id: '2', ms: 1 } });
    await queue.drain();
    expect(log).toEqual(['start 1', 'start 2', 'end 2', 'end 1']);
  });

  it('retries, then calls the failure handler once', async () => {
    const onFailure = vi.fn();
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const queue = new InProcessQueue(onFailure, { attempts: 3, baseDelayMs: 1 });
    queue.register('work', handler);
    await queue.enqueue({ name: 'work', key: 'a', payload: {} });
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps processing a key after a job on it failed', async () => {
    const done = vi.fn();
    const queue = new InProcessQueue(() => {}, { attempts: 1, baseDelayMs: 1 });
    queue.register('fail', async () => {
      throw new Error('boom');
    });
    queue.register('ok', done);
    await queue.enqueue({ name: 'fail', key: 'a', payload: {} });
    await queue.enqueue({ name: 'ok', key: 'a', payload: {} });
    await queue.drain();
    expect(done).toHaveBeenCalledOnce();
  });

  it('refuses a job with no handler', async () => {
    await expect(
      new InProcessQueue().enqueue({ name: 'nope', key: 'a', payload: {} }),
    ).rejects.toThrow(/No handler/);
  });
});
