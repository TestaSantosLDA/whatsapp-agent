import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRuns, conversations, leads, messages } from '../db/schema.js';
import type { Responder } from '../jobs/process-conversation.js';
import { testApp, testClient } from '../test/helpers.js';
import { ClaudeResponder } from './claude-responder.js';
import { defineTool, ToolError } from './tool.js';

type Script = (body: Record<string, unknown>) => Record<string, unknown>;

/** A Claude client whose HTTP calls return scripted messages and record the request bodies. */
function fakeClaude(script: Script[]) {
  const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      const step = script[requests.length - 1];
      if (!step) throw new Error(`unexpected request #${requests.length}`);
      return new Response(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          ...step(body),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { anthropic, requests };
}

const say =
  (text: string, usage?: Record<string, number>): Script =>
  () => ({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    ...(usage ? { usage: { input_tokens: 10, output_tokens: 20, ...usage } } : {}),
  });
const callTool =
  (name: string, input: unknown): Script =>
  () => ({
    content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    stop_reason: 'tool_use',
  });

const flaky = defineTool({
  name: 'flaky_lookup',
  description: 'Test tool that always fails.',
  inputSchema: z.object({ id: z.string() }),
  async run() {
    throw new ToolError('not_found', 'No product with that id.');
  },
});

let current: Awaited<ReturnType<typeof testApp>> | undefined;
afterEach(async () => {
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

async function setup(script: Script[], opts: { tools?: string[] } = {}) {
  const claude = fakeClaude(script);
  // The responder needs the app's database, so the app gets a stand-in that calls it later.
  const lazy: Responder = { respond: (input) => responder.respond(input) };
  current = await testApp({ clients: [testClient({ tools: opts.tools ?? [] })], responder: lazy });
  const responder = new ClaudeResponder({
    db: current.db,
    anthropic: claude.anthropic,
    tools: [flaky],
    now: () => new Date('2026-10-19T10:30:00Z'), // a Monday, when the test branch is open,
  });
  const send = async (text: string) => {
    await current!.app.request('/sim/acme/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '351911111111', name: 'Ana', text }),
    });
    await current!.queue.drain();
  };
  const outbound = () =>
    current!.db.select().from(messages).where(eq(messages.direction, 'outbound'));
  return { ...claude, send, outbound, db: current.db };
}

describe('ClaudeResponder', () => {
  it('sends a cached system prompt, sorted tools, effort and the turn context', async () => {
    const t = await setup([say('Olá! Sou o assistente automático da Acme Madeiras.')]);
    await t.send('Olá');
    const [out] = await t.outbound();
    expect(out?.text).toBe('Olá! Sou o assistente automático da Acme Madeiras.');

    const { body, headers } = t.requests[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.fallbacks).toBe('default');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const system = body.system as { text: string; cache_control: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.text).toContain('European Portuguese');
    expect(system[0]!.text).not.toMatch(/2026/);
    expect((body.tools as { name: string }[]).map((x) => x.name)).toEqual([
      'offer_choices',
      'request_human',
    ]);
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system']);
    expect(JSON.stringify(msgs[0])).toContain('"cache_control":{"type":"ephemeral"}');
    expect(String(msgs[1]!.content)).toMatch(/first message/);
    expect(String(msgs[1]!.content)).toMatch(/Branches open now: lisboa/);
  });

  it('replays earlier turns append-only and records cache reads', async () => {
    const t = await setup([
      say('Olá! Em que posso ajudar?', { cache_creation_input_tokens: 900 }),
      say('Temos sim.', { cache_read_input_tokens: 900 }),
    ]);
    await t.send('Olá');
    await t.send('Têm decks?');
    const second = t.requests[1]!.body.messages as { role: string; content: unknown }[];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(String(second[3]!.content)).not.toMatch(/first message/);
    const runs = await t.db.select().from(agentRuns);
    expect(runs.map((r) => r.cacheReadTokens)).toEqual([0, 900]);
    expect(Number(runs[1]!.costUsd)).toBeGreaterThan(0);
  });

  it('returns a tool error to Claude and still answers the customer', async () => {
    const t = await setup(
      [
        callTool('flaky_lookup', { id: 'x' }),
        (body) => {
          const msgs = body.messages as { role: string; content: unknown }[];
          const result = JSON.stringify(msgs.at(-1));
          expect(result).toContain('"is_error":true');
          expect(result).toContain('not_found');
          return say('Não encontrei esse produto. Quer que um colega confirme?')(body);
        },
      ],
      { tools: ['flaky_lookup'] },
    );
    await t.send('Têm o produto x?');
    const [out] = await t.outbound();
    expect(out?.text).toMatch(/Não encontrei/);
    const [run] = await t.db.select().from(agentRuns);
    expect(run?.toolCalls).toEqual([expect.objectContaining({ name: 'flaky_lookup', ok: false })]);
    expect(run?.error).toBeNull();
  });

  it('attaches offered choices to the reply as buttons', async () => {
    const t = await setup([
      callTool('offer_choices', { options: ['Interior', 'Exterior'] }),
      say('É para interior ou exterior?'),
    ]);
    await t.send('Queria um pavimento');
    const [out] = await t.outbound();
    expect(out?.type).toBe('interactive');
    expect(out?.payload).toMatchObject({
      interactive: {
        type: 'button',
        body: { text: 'É para interior ou exterior?' },
        action: { buttons: [{ reply: { title: 'Interior' } }, { reply: { title: 'Exterior' } }] },
      },
    });
  });

  it('hands over when the customer asks for a person, even if Claude forgets the tool', async () => {
    const t = await setup([say('Claro, um colega vai responder-lhe em breve.')]);
    await t.send('Quero falar com uma pessoa');
    const [conv] = await t.db.select().from(conversations);
    expect(conv?.status).toBe('human');
    const [lead] = await t.db.select().from(leads);
    expect(lead).toMatchObject({ type: 'handoff', branchId: 'lisboa' });
  });

  it('stores the detected language on the contact', async () => {
    const t = await setup([say('Hello! How can I help?')]);
    await t.send('Hello, do you have oak flooring?');
    const { contacts } = await import('../db/schema.js');
    const [contact] = await t.db.select().from(contacts);
    expect(contact?.language).toBe('en');
  });

  it('fails the turn on a refusal, so the customer gets the apology and a person', async () => {
    const t = await setup([0, 1, 2].map(() => () => ({ content: [], stop_reason: 'refusal' })));
    await t.send('Olá');
    const [conv] = await t.db.select().from(conversations);
    expect(conv?.status).toBe('human');
    const runs = await t.db.select().from(agentRuns);
    expect(runs[0]?.error).toMatch(/refusal/);
  }, 15_000);
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('ClaudeResponder live smoke test', () => {
  it('greets in European Portuguese and in English', async () => {
    current = await testApp({ responder: { respond: (i) => live!.respond(i) } });
    const live: ClaudeResponder | undefined = new ClaudeResponder({
      db: current.db,
      anthropic: new Anthropic(),
      tools: [],
    });
    for (const [phone, text] of [
      ['351911111111', 'Olá'],
      ['447700900123', 'Hello'],
    ] as const) {
      await current.app.request('/sim/acme/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, name: 'Teste', text }),
      });
    }
    await current.queue.drain();
    const out = await current.db.select().from(messages).where(eq(messages.direction, 'outbound'));
    expect(out).toHaveLength(2);
  }, 120_000);
});
