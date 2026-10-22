import type { BackofficeEvent } from '@wa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRuns, conversations, leads, outbox } from '../db/schema.js';
import { testApp, testClient } from '../test/helpers.js';

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

const PHONE = '351911111111';

/** Reads SSE events from a streaming response until `count` events have arrived. */
async function readEvents(res: Response, count: number): Promise<BackofficeEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: BackofficeEvent[] = [];
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

/** Sends one customer message so the contact and an open conversation exist. */
async function startConversation(t: TestApp) {
  await t.app.request('/sim/acme/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, name: 'Rui', text: 'Olá' }),
  });
  await t.queue.drain();
  const [conversation] = await t.db.select().from(conversations);
  return conversation!;
}

describe('GET /sim/:clientId/backoffice', () => {
  it('sends an empty snapshot when the customer has no open conversation', async () => {
    const { app } = await setup();
    const res = await app.request(`/sim/acme/backoffice?phone=${PHONE}`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await readEvents(res, 1)).toEqual([
      { type: 'snapshot', conversationStatus: 'bot', leads: [], emails: [], turns: [] },
    ]);
  });

  it('sends a snapshot of the open conversation, then live events', async () => {
    const t = await setup();
    const conversation = await startConversation(t);
    await t.db.insert(leads).values({
      clientId: 'acme',
      conversationId: conversation.id,
      type: 'quote',
      branchId: 'lisboa',
      fields: { name: 'Rui', area: '40 m2' },
    });

    const res = await t.app.request(`/sim/acme/backoffice?phone=${PHONE}`);
    const eventsPromise = readEvents(res, 5);
    await new Promise((r) => setTimeout(r, 20));

    const client = testClient();
    const [lead] = await t.db
      .insert(leads)
      .values({ clientId: 'acme', conversationId: conversation.id, type: 'handoff' })
      .returning();
    t.backoffice.publishLead(client, PHONE, lead!);
    const [email] = await t.db
      .insert(outbox)
      .values({
        clientId: 'acme',
        conversationId: conversation.id,
        kind: 'lead',
        to: ['lisboa@acme.test'],
        subject: 'Novo pedido de orçamento',
        body: 'Rui quer 40 m2 de deck.',
      })
      .returning();
    t.backoffice.publishEmail('acme', PHONE, email!);
    const [turn] = await t.db
      .insert(agentRuns)
      .values({
        clientId: 'acme',
        conversationId: conversation.id,
        model: 'claude-test',
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 1000,
        costUsd: '0.001234',
        latencyMs: 900,
        toolCalls: [{ name: 'search_products', input: { query: 'deck' }, ok: true, ms: 12 }],
      })
      .returning();
    t.backoffice.publishTurn('acme', PHONE, turn!);
    t.backoffice.publishStatus('acme', PHONE, 'human');
    // Another customer's events stay out of this stream.
    t.backoffice.publishStatus('acme', '351922222222', 'closed');

    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual([
      'snapshot',
      'lead',
      'email',
      'turn',
      'conversation',
    ]);
    expect(events[0]).toMatchObject({
      type: 'snapshot',
      conversationStatus: 'bot',
      leads: [
        {
          type: 'quote',
          branchId: 'lisboa',
          branchName: 'Lisboa',
          fields: { name: 'Rui', area: '40 m2' },
        },
      ],
      emails: [],
      turns: [],
    });
    expect(events[1]).toMatchObject({ lead: { id: lead!.id, type: 'handoff', branchName: null } });
    expect(events[2]).toMatchObject({
      email: { id: email!.id, to: ['lisboa@acme.test'], subject: 'Novo pedido de orçamento' },
    });
    expect(events[3]).toMatchObject({
      turn: {
        id: turn!.id,
        costUsd: 0.001234,
        cacheReadTokens: 1000,
        toolCalls: [{ name: 'search_products', ok: true }],
      },
    });
    expect(events[4]).toEqual({ type: 'conversation', status: 'human' });
  });

  it('includes emails and turns in the snapshot after a reconnect', async () => {
    const t = await setup();
    const conversation = await startConversation(t);
    await t.db.insert(outbox).values({
      clientId: 'acme',
      conversationId: conversation.id,
      kind: 'handoff',
      to: ['a@acme.test'],
      subject: 's',
      body: 'b',
    });
    const [snapshot] = await readEvents(
      await t.app.request(`/sim/acme/backoffice?phone=${PHONE}`),
      1,
    );
    expect(snapshot).toMatchObject({ emails: [{ kind: 'handoff', subject: 's' }] });
    // The echo bot writes no agent run; the Claude responder does (WA-009).
    expect(snapshot).toMatchObject({ turns: [] });
  });

  it('answers 404 for a client that is not on the simulator and 400 for a bad phone', async () => {
    const real = testClient({
      id: 'real',
      channel: {
        type: 'whatsapp_cloud',
        phone_number_id: 'real-phone-id',
        display_phone_number: '+351 220 000 000',
        waba_id: 'waba',
        access_token_env: 'REAL_TOKEN',
      },
    });
    const { app } = await setup({ clients: [testClient(), real] });
    expect((await app.request(`/sim/real/backoffice?phone=${PHONE}`)).status).toBe(404);
    expect((await app.request(`/sim/nope/backoffice?phone=${PHONE}`)).status).toBe(404);
    expect((await app.request('/sim/acme/backoffice?phone=abc')).status).toBe(400);
  });

  it('requires the access code, also as a query parameter', async () => {
    const { app } = await setup({ env: { SIMULATOR_ACCESS_CODE: 'demo-1234' } });
    expect((await app.request(`/sim/acme/backoffice?phone=${PHONE}`)).status).toBe(401);
    expect((await app.request(`/sim/acme/backoffice?phone=${PHONE}&code=wrong`)).status).toBe(401);
    const res = await app.request(`/sim/acme/backoffice?phone=${PHONE}&code=demo-1234`);
    expect(res.status).toBe(200);
    expect(await readEvents(res, 1)).toMatchObject([{ type: 'snapshot' }]);
  });
});
