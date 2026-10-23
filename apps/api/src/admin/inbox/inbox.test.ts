import Anthropic from '@anthropic-ai/sdk';
import type {
  InboxConversation,
  InboxConversationDetail,
  InboxEvent,
  InboxList,
  InboxMessage,
  SimEvent,
} from '@wa/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeResponder } from '../../agent/claude-responder.js';
import { COLLEAGUE_REPLY_PREFIX } from '../../agent/history.js';
import { agentTools } from '../../agent/registry.js';
import { messages, outbox } from '../../db/schema.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { adminTestApp } from '../../test/admin.js';
import { testClient } from '../../test/helpers.js';

const base = testClient();
const client = testClient({
  branches: [
    { ...base.branches[0]!, hours: { mon: ['00:00-23:59'] } },
    { ...base.branches[0]!, id: 'porto', name: 'Porto', region: 'Porto', address: 'Rua 2, Porto' },
  ],
});

const ANA = '351911111111';
const RUI = '351922222222';

interface ClaudeRequest {
  messages: { role: string; content: unknown }[];
}

/**
 * Claude from a script: "pessoa" in the customer's last message hands over to Lisboa, a tool
 * result is answered with a goodbye, anything else with a greeting. Records every request.
 */
function fakeClaude() {
  const requests: ClaudeRequest[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ClaudeRequest;
      requests.push(body);
      const last = JSON.stringify(body.messages.at(-1));
      const n = requests.length;
      const reply = (step: Record<string, unknown>) =>
        Response.json({
          id: `msg_${n}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          ...step,
        });
      if (last.includes('tool_result')) {
        return reply({
          content: [{ type: 'text', text: 'Um colega de Lisboa responde aqui em breve.' }],
          stop_reason: 'end_turn',
        });
      }
      if (JSON.stringify(body.messages).includes('pessoa')) {
        return reply({
          content: [
            {
              type: 'tool_use',
              id: `toolu_${n}`,
              name: 'handoff_to_human',
              input: {
                reason: 'customer_asked',
                summary: 'Quer falar com uma pessoa.',
                branch_id: 'lisboa',
              },
            },
          ],
          stop_reason: 'tool_use',
        });
      }
      return reply({
        content: [{ type: 'text', text: 'Olá! Em que posso ajudar?' }],
        stop_reason: 'end_turn',
      });
    },
  });
  return { anthropic, requests };
}

let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

async function setup() {
  const claude = fakeClaude();
  const lazy: Responder = {
    respond: (input) => responder.respond(input),
    invalidate: (id) => responder.invalidate(id),
  };
  const t = await adminTestApp({ clients: [client], responder: lazy });
  const responder = new ClaudeResponder({
    db: t.db,
    anthropic: claude.anthropic,
    tools: agentTools,
    backoffice: t.backoffice,
    mailer: t.mailer,
    // A Monday morning: Lisboa is open.
    now: () => new Date('2026-10-19T10:30:00Z'),
  });
  const admin = await t.member('acme', { email: 'admin@example.invalid', role: 'admin' });
  const lisboa = await t.member('acme', {
    email: 'lisboa@example.invalid',
    name: 'Sara',
    role: 'sales',
    branches: ['lisboa'],
  });
  const porto = await t.member('acme', {
    email: 'porto@example.invalid',
    role: 'sales',
    branches: ['porto'],
  });

  /** A customer writes in the simulator; waits for the agent and the inbox to react. */
  const send = async (phone: string, text: string) => {
    await t.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, name: phone === ANA ? 'Ana' : 'Rui', text }),
    });
    await t.queue.drain();
    await t.inbox.flush();
  };
  const api = async <T>(path: string, token: string, init: RequestInit = {}) => {
    const res = await t.call(`/api/admin/clients/acme/inbox${path}`, token, init);
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  const post = <T>(path: string, token: string, body?: unknown) =>
    api<T>(path, token, {
      method: 'POST',
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const list = async (token: string, query = '') =>
    (await api<InboxList>(query ? `?${query}` : '', token)).body;
  const alerts = async () =>
    (await t.db.select().from(outbox).orderBy(asc(outbox.createdAt))).filter(
      (e) => e.kind === 'inbox_alert',
    );

  return { ...t, claude, admin, lisboa, porto, send, api, post, list, alerts };
}

/** Reads SSE `data:` events from a streaming response until `count` have arrived. */
async function readEvents<E>(res: Response, count: number): Promise<E[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: E[] = [];
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
      if (data) events.push(JSON.parse(data.slice(6)) as E);
    }
  }
  await reader.cancel();
  return events;
}

describe('inbox', () => {
  it('scopes the list by branch and filters it', async () => {
    const t = (current = await setup());
    await t.send(ANA, 'Quero falar com uma pessoa');
    await t.send(RUI, 'Olá');

    // Ana was handed over to Lisboa; Rui is still with the bot and has no branch yet.
    const all = await t.list(t.admin.token);
    expect(all.conversations.map((c) => [c.contact.phone, c.status, c.branchId])).toEqual([
      [RUI, 'bot', null],
      [ANA, 'human', 'lisboa'],
    ]);
    expect(all.needsPerson).toBe(1);
    expect((await t.list(t.admin.token, 'view=human')).conversations).toHaveLength(1);

    const lisboa = await t.list(t.lisboa.token);
    expect(lisboa.conversations.map((c) => c.contact.phone)).toEqual([ANA]);
    expect(lisboa.needsPerson).toBe(1);
    expect((await t.list(t.porto.token)).conversations).toEqual([]);

    const ana = lisboa.conversations[0]!;
    expect((await t.api(`/${ana.id}`, t.porto.token)).status).toBe(404);
    expect((await t.post(`/${ana.id}/takeover`, t.porto.token)).status).toBe(404);
    expect((await t.api('?branch=lisboa', t.porto.token)).status).toBe(403);
    expect((await t.api('?view=nope', t.admin.token)).status).toBe(400);

    // The detail has the transcript and the handoff lead.
    const detail = (await t.api<InboxConversationDetail>(`/${ana.id}`, t.lisboa.token)).body;
    expect(detail.messages.map((m) => [m.direction, m.text])).toEqual([
      ['inbound', 'Quero falar com uma pessoa'],
      ['outbound', 'Um colega de Lisboa responde aqui em breve.'],
    ]);
    expect(detail.leads.map((l) => l.type)).toEqual(['handoff']);
    expect(detail.assignable.map((m) => m.email).sort()).toEqual([
      'admin@example.invalid',
      'lisboa@example.invalid',
    ]);

    // "Mine" after a takeover; only members who work with the branch can be assigned.
    await t.post(`/${ana.id}/takeover`, t.lisboa.token);
    const mine = await t.list(t.lisboa.token, 'view=mine');
    expect(mine.conversations.map((c) => [c.id, c.assignedTo?.email])).toEqual([
      [ana.id, 'lisboa@example.invalid'],
    ]);
    expect((await t.list(t.admin.token, 'view=mine')).conversations).toEqual([]);
    const assign = await t.post(`/${ana.id}/assign`, t.admin.token, { memberId: t.porto.row.id });
    expect(assign.status).toBe(400);
  });

  it('takes over, replies through the simulator channel and hands back with the replies in the history', async () => {
    const t = (current = await setup());
    await t.send(RUI, 'Olá');
    const [rui] = (await t.list(t.admin.token)).conversations;
    expect(t.claude.requests).toHaveLength(1);

    // Take over: the agent stays silent and the customer's message waits, unread, in the inbox.
    const taken = await t.post<InboxConversation>(`/${rui!.id}/takeover`, t.lisboa.token);
    expect(taken.status).toBe(404); // not Lisboa's (no branch yet)
    const ok = await t.post<InboxConversation>(`/${rui!.id}/takeover`, t.admin.token);
    expect(ok.body).toMatchObject({
      status: 'human',
      assignedTo: { email: 'admin@example.invalid' },
    });
    await t.send(RUI, 'Têm deck de pinho?');
    expect(t.claude.requests).toHaveLength(1);
    const rows = await t.db.select().from(messages).where(eq(messages.conversationId, rui!.id));
    expect(rows.filter((m) => m.direction === 'outbound')).toHaveLength(1);
    let row = (await t.list(t.admin.token)).conversations[0]!;
    expect(row.unread).toBe(1);
    await t.post(`/${rui!.id}/read`, t.admin.token);
    row = (await t.list(t.admin.token)).conversations[0]!;
    expect(row.unread).toBe(0);

    // The reply shows up in the customer's simulator chat (its SSE stream).
    const chat = await t.app.request(`/sim/acme/stream?phone=${RUI}`);
    const chatEvents = readEvents<SimEvent>(chat, 3);
    await new Promise((r) => setTimeout(r, 50));
    const reply = await t.post<InboxMessage>(`/${rui!.id}/reply`, t.admin.token, {
      text: 'Temos sim, 24 €/m². Quer amostra?',
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      direction: 'outbound',
      sentBy: { email: 'admin@example.invalid' },
    });
    const [history, ...live] = await chatEvents;
    expect(history?.type).toBe('history');
    expect(live.find((e) => e.type === 'message')).toMatchObject({
      type: 'message',
      message: {
        direction: 'outbound',
        payload: { type: 'text', text: { body: 'Temos sim, 24 €/m². Quer amostra?' } },
      },
    });
    const [sent] = await t.db.select().from(messages).where(eq(messages.id, reply.body.id));
    expect(sent!.sentByMemberId).toBe(t.admin.row.id);
    expect((await t.post(`/${rui!.id}/reply`, t.admin.token, { text: '  ' })).status).toBe(400);

    // Back to the bot: the next customer message is answered, with the person's reply in the history.
    const back = await t.post<InboxConversation>(`/${rui!.id}/bot`, t.admin.token);
    expect(back.body).toMatchObject({ status: 'bot', assignedTo: null });
    await t.send(RUI, 'Sim, quero amostra');
    expect(t.claude.requests).toHaveLength(2);
    const sentToClaude = JSON.stringify(t.claude.requests[1]!.messages);
    expect(sentToClaude).toContain(`${COLLEAGUE_REPLY_PREFIX} Temos sim, 24 €/m². Quer amostra?`);
    expect(sentToClaude).toContain('Têm deck de pinho?');

    const detail = (await t.api<InboxConversationDetail>(`/${rui!.id}`, t.admin.token)).body;
    expect(detail.messages.map((m) => [m.direction, m.sentBy?.email ?? null])).toEqual([
      ['inbound', null],
      ['outbound', null],
      ['inbound', null],
      ['outbound', 'admin@example.invalid'],
      ['inbound', null],
      ['outbound', null],
    ]);
  });

  it('a reply to a bot conversation takes it over first', async () => {
    const t = (current = await setup());
    await t.send(RUI, 'Olá');
    const [rui] = (await t.list(t.admin.token)).conversations;
    await t.post(`/${rui!.id}/reply`, t.admin.token, { text: 'Bom dia, sou a Marta.' });
    const [row] = (await t.list(t.admin.token)).conversations;
    expect(row).toMatchObject({ status: 'human', assignedTo: { email: 'admin@example.invalid' } });
    await t.send(RUI, 'Bom dia');
    expect(t.claude.requests).toHaveLength(1);
  });

  it('emails the branch on a handoff and the assigned member on later messages', async () => {
    const t = (current = await setup());
    await t.send(ANA, 'Quero falar com uma pessoa');

    // Handoff, nobody assigned: Lisboa's team (the admin is on no branch).
    let alerts = await t.alerts();
    expect(alerts.map((a) => a.to)).toEqual([['lisboa@example.invalid']]);
    expect(alerts[0]!.subject).toContain('Ana');
    expect(alerts[0]!.body).toContain('/admin/inbox/');

    // More customer messages within minutes: no new email to the same people.
    await t.send(ANA, 'Estão aí?');
    expect(await t.alerts()).toHaveLength(1);

    // Assigned to the admin: they get an "assigned" email, then the customer's next message.
    const [ana] = (await t.list(t.lisboa.token)).conversations;
    await t.post(`/${ana!.id}/assign`, t.lisboa.token, { memberId: t.admin.row.id });
    await t.send(ANA, 'Olá?');
    alerts = await t.alerts();
    expect(alerts.map((a) => [a.to, a.subject])).toEqual([
      [['lisboa@example.invalid'], expect.stringContaining('à espera')],
      [['admin@example.invalid'], expect.stringContaining('atribuída')],
      [['admin@example.invalid'], expect.stringContaining('Nova mensagem')],
    ]);

    // The bot's own conversations send no alerts.
    await t.send(RUI, 'Olá');
    expect(await t.alerts()).toHaveLength(3);
  });

  it('streams changed rows in the member scope', async () => {
    const t = (current = await setup());
    const stream = await t.call(
      `/api/admin/clients/acme/inbox/stream?access_token=${t.lisboa.token}`,
      undefined,
      { headers: { accept: 'text/event-stream' } },
    );
    expect(stream.status).toBe(200);
    const events = readEvents<InboxEvent>(stream, 1);
    await new Promise((r) => setTimeout(r, 50));
    // Rui (no branch) is not Lisboa's; Ana's handoff is.
    await t.send(RUI, 'Olá');
    await t.send(ANA, 'Quero falar com uma pessoa');
    const [first] = await events;
    expect(first).toMatchObject({
      type: 'conversation',
      conversation: { contact: { phone: ANA }, branchId: 'lisboa' },
    });
  });
});
