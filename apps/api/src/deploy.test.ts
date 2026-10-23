import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversations, messages } from './db/schema.js';
import { loadEnv } from './env.js';
import type { Responder } from './jobs/process-conversation.js';
import { fixture, postSimWebhook, SECRET, testApp } from './test/helpers.js';

const JOBS_SECRET = 'test-jobs-secret-123';
const cloudEnv = {
  QUEUE: 'cloudtasks',
  GCP_PROJECT: 'wa-demo',
  CLOUD_TASKS_LOCATION: 'europe-west1',
  CLOUD_TASKS_QUEUE: 'conversations',
  CLOUD_TASKS_DELAY_MS: '0',
  JOBS_SECRET,
  PUBLIC_BASE_URL: 'https://wa-api.example.run.app',
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stands in for the metadata server and the Cloud Tasks API; records the created tasks. */
function stubGoogle() {
  const tasks: { url: string; headers: Record<string, string>; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://metadata.google.internal/')) {
        return Response.json({ access_token: 'tok', expires_in: 3600 });
      }
      if (url.startsWith('https://cloudtasks.googleapis.com/')) {
        const { task } = JSON.parse(init!.body as string);
        tasks.push({
          url: task.httpRequest.url,
          headers: task.httpRequest.headers,
          payload: JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString()),
        });
        return Response.json({ name: `task-${tasks.length}` });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return tasks;
}

describe('QUEUE=cloudtasks', () => {
  it('queues a task per message and answers the turn when Cloud Tasks delivers it', async () => {
    const tasks = stubGoogle();
    const responder: Responder = { respond: async () => [{ type: 'text', text: 'olá' }] };
    const t = await testApp({ env: cloudEnv, responder });
    cleanups.push(t.close);

    expect((await postSimWebhook(t.app, fixture('text'))).status).toBe(200);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.url).toBe('https://wa-api.example.run.app/jobs/run/process-conversation');
    // Nothing ran in-process: the reply waits for the delivery.
    expect((await t.db.select().from(messages)).map((m) => m.direction)).toEqual(['inbound']);

    const path = new URL(task.url).pathname;
    expect((await t.app.request(path, { method: 'POST', body: '{}' })).status).toBe(401);
    const res = await t.app.request(path, {
      method: 'POST',
      headers: { ...task.headers, 'x-cloudtasks-taskretrycount': '0' },
      body: JSON.stringify(task.payload),
    });
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(messages);
    expect(rows.filter((m) => m.direction === 'outbound')).toHaveLength(1);
    expect(rows.every((m) => m.direction === 'outbound' || m.processedAt)).toBe(true);
  });

  it('answers 500 so Cloud Tasks retries, and hands over after the last attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tasks = stubGoogle();
    const responder: Responder = {
      respond: async () => {
        throw new Error('Claude is down');
      },
    };
    const t = await testApp({ env: cloudEnv, responder });
    cleanups.push(t.close);
    await postSimWebhook(t.app, fixture('text'));
    const task = tasks[0]!;
    const deliver = (retry: number) =>
      t.app.request('/jobs/run/process-conversation', {
        method: 'POST',
        headers: { ...task.headers, 'x-cloudtasks-taskretrycount': String(retry) },
        body: JSON.stringify(task.payload),
      });

    expect((await deliver(0)).status).toBe(500);
    expect((await deliver(1)).status).toBe(500);
    expect((await deliver(2)).status).toBe(200);
    const [conversation] = await t.db.select().from(conversations);
    expect(conversation!.status).toBe('human');
  });

  it('is not reachable with the in-process queue', async () => {
    const t = await testApp({ env: { JOBS_SECRET } });
    cleanups.push(t.close);
    const res = await t.app.request('/jobs/run/process-conversation', {
      method: 'POST',
      headers: { 'x-jobs-secret': JOBS_SECRET },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('requires its settings and an https base URL', () => {
    expect(() => loadEnv({ SIMULATOR_WEBHOOK_SECRET: SECRET, QUEUE: 'cloudtasks' })).toThrow(
      /GCP_PROJECT[\s\S]*CLOUD_TASKS_LOCATION[\s\S]*CLOUD_TASKS_QUEUE[\s\S]*JOBS_SECRET[\s\S]*PUBLIC_BASE_URL/,
    );
    expect(loadEnv({ SIMULATOR_WEBHOOK_SECRET: SECRET, ...cloudEnv }).QUEUE).toBe('cloudtasks');
  });
});

describe('serving the simulator', () => {
  function distDir() {
    const dir = mkdtempSync(join(tmpdir(), 'wa-sim-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>sim</title>');
    writeFileSync(join(dir, 'main-ABCD1234.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.ico'), 'ico');
    mkdirSync(join(dir, 'media'));
    writeFileSync(join(dir, 'media', 'font-WXYZ9876.css'), 'body{}');
    return dir;
  }

  async function app() {
    const t = await testApp({ env: { SIMULATOR_DIST_DIR: distDir() }, serveSimulator: true });
    cleanups.push(t.close);
    return t.app;
  }

  it('serves index.html at / and as the fallback for client-side routes', async () => {
    const a = await app();
    const root = await a.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('<title>sim</title>');

    const deep = await a.request('/some/route', { headers: { accept: 'text/html' } });
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<title>sim</title>');
  });

  it('caches hashed assets for a year and other files for an hour', async () => {
    const a = await app();
    const js = await a.request('/main-ABCD1234.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const css = await a.request('/media/font-WXYZ9876.css');
    expect(css.headers.get('cache-control')).toContain('immutable');
    const ico = await a.request('/favicon.ico');
    expect(ico.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('leaves API routes, missing files and path traversal alone', async () => {
    const a = await app();
    expect((await a.request('/health')).status).toBe(200);
    expect((await a.request('/healthz')).status).toBe(200);
    expect((await a.request('/sim/config')).headers.get('content-type')).toContain(
      'application/json',
    );
    const unknownApi = await a.request('/sim/nope/unknown', { headers: { accept: 'text/html' } });
    expect(await unknownApi.text()).not.toContain('<title>sim</title>');
    expect((await a.request('/missing-ABCD1234.js')).status).toBe(404);
    expect((await a.request('/..%2F..%2Fetc%2Fpasswd')).status).not.toBe(200);
  });
});

describe('serving the team dashboard at /admin', () => {
  function dist(title: string) {
    const dir = mkdtempSync(join(tmpdir(), 'wa-spa-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${title}</title>`);
    writeFileSync(join(dir, `${title}-ABCD1234.js`), 'console.log(1)');
    writeFileSync(join(dir, 'chunk-D-Rz4jH9.js'), 'console.log(2)');
    return dir;
  }

  async function app(withAdmin = true) {
    const env: Record<string, string> = {
      SIMULATOR_DIST_DIR: dist('sim'),
      ADMIN_DIST_DIR: withAdmin ? dist('admin') : join(tmpdir(), 'wa-no-admin-dist'),
    };
    const t = await testApp({ env, serveSimulator: true, serveAdmin: true });
    cleanups.push(t.close);
    return t.app;
  }
  const html = { headers: { accept: 'text/html' } };

  it('serves the dashboard and its client-side routes, the simulator everywhere else', async () => {
    const a = await app();
    for (const path of ['/admin', '/admin/', '/admin/settings', '/admin/leads/123']) {
      const res = await a.request(path, html);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<title>admin</title>');
    }
    const js = await a.request('/admin/admin-ABCD1234.js');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const chunk = await a.request('/admin/chunk-D-Rz4jH9.js');
    expect(chunk.headers.get('cache-control')).toContain('immutable');
    expect((await a.request('/admin/sim-ABCD1234.js')).status).toBe(404);
    expect(await (await a.request('/', html)).text()).toContain('<title>sim</title>');
    expect(await (await a.request('/administration', html)).text()).toContain('<title>sim</title>');
    expect((await a.request('/admin/..%2F..%2Fetc%2Fpasswd')).status).not.toBe(200);
  });

  it('keeps /admin/config and /api/admin for the API', async () => {
    const a = await app();
    const config = await a.request('/admin/config', html);
    expect(config.headers.get('content-type')).toContain('application/json');
    expect(config.headers.get('cache-control')).toBe('no-store');
    const api = await a.request('/api/admin/me', html);
    expect(api.status).toBe(401);
    expect(api.headers.get('content-type')).toContain('application/json');
  });

  it('never falls back to the simulator below /admin when the dashboard is not built', async () => {
    const a = await app(false);
    expect((await a.request('/admin/settings', html)).status).toBe(404);
    expect(await (await a.request('/', html)).text()).toContain('<title>sim</title>');
  });
});
