import type { SimEvent } from '@wa/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { messages } from './db/schema.js';
import type { Responder } from './jobs/process-conversation.js';
import { fixture, postSimWebhook, testApp } from './test/helpers.js';

type TestApp = Awaited<ReturnType<typeof testApp>>;
let current: TestApp | undefined;
async function setup(opts?: Parameters<typeof testApp>[0]) {
  current = await testApp(opts);
  return current;
}
afterEach(async () => {
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

/** Reads SSE events from a streaming response until `count` events have arrived. */
async function readEvents(res: Response, count: number): Promise<SimEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SimEvent[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  await reader.cancel();
  return events;
}

describe('health', () => {
  it('answers ok', async () => {
    const { app } = await setup();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /webhook/:channel', () => {
  it('stores a duplicated delivery once and runs one turn', async () => {
    let turns = 0;
    const responder: Responder = {
      respond: async () => {
        turns++;
        return [{ type: 'text', text: 'ok' }];
      },
    };
    const { app, queue, db } = await setup({ responder });
    const body = fixture('text');
    expect((await postSimWebhook(app, body)).status).toBe(200);
    expect((await postSimWebhook(app, body)).status).toBe(200);
    await queue.drain();

    const rows = await db.select().from(messages);
    expect(rows.filter((r) => r.direction === 'inbound')).toHaveLength(1);
    expect(rows.filter((r) => r.direction === 'outbound')).toHaveLength(1);
    expect(turns).toBe(1);
  });

  it('answers before the turn finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = await setup({ responder: { respond: async () => (await gate, []) } });
    const started = performance.now();
    const res = await postSimWebhook(app, fixture('text'));
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(200);
    release();
  });

  it('rejects the simulator webhook without the shared secret', async () => {
    const { app } = await setup();
    const res = await app.request('/webhook/simulator', { method: 'POST', body: fixture('text') });
    expect(res.status).toBe(401);
  });

  it('refuses the WhatsApp webhook while the channel is not configured', async () => {
    const { app } = await setup();
    const res = await app.request('/webhook/whatsapp', { method: 'POST', body: fixture('text') });
    expect(res.status).toBe(503);
  });

  it('answers 400 to a body that is not a webhook', async () => {
    const { app } = await setup();
    expect((await postSimWebhook(app, '{"nope":1}')).status).toBe(400);
    expect((await postSimWebhook(app, 'not json')).status).toBe(400);
  });

  it('acknowledges messages for an unknown number without storing them', async () => {
    const { app, db } = await setup();
    const res = await postSimWebhook(app, fixture('text').replace('test-phone-id', 'unknown'));
    expect(res.status).toBe(200);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('completes the Meta verification handshake only with the right token', async () => {
    const { app } = await setup({ env: { WHATSAPP_VERIFY_TOKEN: 'tok' } });
    const ok = await app.request(
      '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42',
    );
    expect(await ok.text()).toBe('42');
    const bad = await app.request(
      '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42',
    );
    expect(bad.status).toBe(403);
  });
});

describe('conversation turns', () => {
  it('answers two quick messages in one turn', async () => {
    const seen: string[][] = [];
    const responder: Responder = {
      respond: async ({ newMessages }) => {
        seen.push(newMessages.map((m) => m.text ?? ''));
        return [{ type: 'text', text: 'resposta' }];
      },
    };
    const { app, queue } = await setup({ responder, debounceMs: 300 });
    const send = (text: string) =>
      app.request('/sim/acme/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '351911111111', name: 'Rui', text }),
      });
    await send('Olá');
    await new Promise((r) => setTimeout(r, 100));
    await send('Têm decks?');
    await queue.drain();
    expect(seen).toEqual([['Olá', 'Têm decks?']]);
  });

  it('stays silent when a person has taken over', async () => {
    const { app, queue, db } = await setup();
    await postSimWebhook(app, fixture('text'));
    await queue.drain();
    const { conversations } = await import('./db/schema.js');
    await db.update(conversations).set({ status: 'human' });
    await postSimWebhook(app, fixture('button-reply'));
    await queue.drain();
    const outbound = await db.select().from(messages).where(eq(messages.direction, 'outbound'));
    expect(outbound).toHaveLength(1);
  });

  it('apologises and hands over to a person when the responder keeps failing', async () => {
    const { app, queue, db } = await setup({
      responder: {
        respond: async () => {
          throw new Error('model down');
        },
      },
    });
    await postSimWebhook(app, fixture('text'));
    await queue.drain();
    const [out] = await db.select().from(messages).where(eq(messages.direction, 'outbound'));
    expect(out?.text).toMatch(/problema técnico/);
    const { conversations } = await import('./db/schema.js');
    const [conv] = await db.select().from(conversations);
    expect(conv?.status).toBe('human');
  }, 15_000);
});

describe('simulator API', () => {
  it('lists simulator clients', async () => {
    const { app } = await setup();
    const res = await app.request('/sim/clients');
    expect(await res.json()).toEqual([
      {
        id: 'acme',
        name: 'Acme Madeiras',
        displayPhoneNumber: '+351 210 000 000',
        languages: ['pt-PT', 'en'],
      },
    ]);
  });

  it('streams history, the customer message, read status, typing and the echo reply', async () => {
    const { app } = await setup();
    const stream = await app.request('/sim/acme/stream?phone=351911111111');
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const eventsPromise = readEvents(stream, 6);

    await new Promise((r) => setTimeout(r, 20));
    const res = await app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '351911111111', name: 'Rui', text: 'Olá' }),
    });
    const { messageId } = (await res.json()) as { messageId: string };

    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual([
      'history',
      'message',
      'status',
      'typing',
      'typing',
      'message',
    ]);
    expect(events[1]).toMatchObject({
      message: { id: messageId, direction: 'inbound', text: 'Olá' },
    });
    expect(events[2]).toMatchObject({ messageId, status: 'read' });
    expect(events[5]).toMatchObject({
      message: { direction: 'outbound', payload: { type: 'text' } },
    });
  });

  it('keeps customers apart and returns history on reconnect', async () => {
    const { app, queue } = await setup();
    const send = (phone: string, text: string) =>
      app.request('/sim/acme/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, name: 'X', text }),
      });
    await send('351911111111', 'um');
    await send('351922222222', 'dois');
    await queue.drain();
    const [history] = await readEvents(await app.request('/sim/acme/stream?phone=351922222222'), 1);
    expect(history).toMatchObject({ type: 'history' });
    const texts =
      history!.type === 'history'
        ? history!.messages.map((m) => (m.direction === 'inbound' ? m.text : 'reply'))
        : [];
    expect(texts).toEqual(['dois', 'reply']);
  });

  it('starts a fresh conversation after a reset', async () => {
    const { app, queue } = await setup();
    await app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '351911111111', name: 'X', text: 'olá' }),
    });
    await queue.drain();
    expect(
      (await app.request('/sim/acme/reset?phone=351911111111', { method: 'POST' })).status,
    ).toBe(204);
    const [history] = await readEvents(await app.request('/sim/acme/stream?phone=351911111111'), 1);
    expect(history).toEqual({ type: 'history', messages: [], conversationStatus: 'bot' });
  });

  it('validates the message body', async () => {
    const { app } = await setup();
    const res = await app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: 'abc', name: 'X', text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires the access code when one is set', async () => {
    const { app } = await setup({ env: { SIMULATOR_ACCESS_CODE: 'demo-1234' } });
    expect(await (await app.request('/sim/config')).json()).toEqual({ accessCodeRequired: true });
    expect((await app.request('/sim/clients')).status).toBe(401);
    expect(
      (await app.request('/sim/clients', { headers: { 'x-access-code': 'demo-1234' } })).status,
    ).toBe(200);
    expect((await app.request('/sim/clients?code=demo-1234')).status).toBe(200);
  });

  it('serves the demo image and nothing outside the public folder', async () => {
    const { app } = await setup();
    const res = await app.request('/static/demo-product.svg');
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect((await app.request('/static/..%2Fpackage.json')).status).toBe(404);
  });
});

describe('echo responder', () => {
  it('shows buttons, a list and an image on request', async () => {
    const { app, queue, db } = await setup();
    for (const text of ['botões', 'lista', 'imagem']) {
      await app.request('/sim/acme/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '351911111111', name: 'X', text }),
      });
      await queue.drain();
    }
    const out = await db.select().from(messages).where(eq(messages.direction, 'outbound'));
    expect(
      out.map(
        (m) =>
          (m.payload as { type: string; interactive?: { type: string } }).interactive?.type ??
          m.type,
      ),
    ).toEqual(['button', 'list', 'image']);
  });
});
