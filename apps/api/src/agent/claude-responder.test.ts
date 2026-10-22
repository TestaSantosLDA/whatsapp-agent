import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRuns, conversations, leads, messages, outbox } from '../db/schema.js';
import { EventBus } from '../bus.js';
import type { Responder } from '../jobs/process-conversation.js';
import { testApp, testClient } from '../test/helpers.js';
import type { BackofficeEvent, ClientConfig } from '@wa/shared';
import { seedCatalogue, shopClient, V } from '../test/catalogue.js';
import { ClaudeResponder } from './claude-responder.js';
import { agentTools } from './registry.js';
import { defineTool, ToolError, type AgentTool } from './tool.js';

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

async function setup(
  script: Script[],
  opts: { tools?: string[]; client?: ClientConfig; registry?: AgentTool[]; now?: Date } = {},
) {
  const claude = fakeClaude(script);
  // The responder needs the app's database, so the app gets a stand-in that calls it later.
  const lazy: Responder = { respond: (input) => responder.respond(input) };
  current = await testApp({
    clients: [opts.client ?? testClient({ tools: opts.tools ?? [] })],
    responder: lazy,
  });
  const responder = new ClaudeResponder({
    db: current.db,
    anthropic: claude.anthropic,
    tools: opts.registry ?? [flaky],
    now: () => opts.now ?? new Date('2026-10-19T10:30:00Z'), // a Monday, when the test branch is open,
    backoffice: current.backoffice,
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
  return {
    ...claude,
    send,
    outbound,
    db: current.db,
    app: current.app,
    backoffice: current.backoffice,
  };
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
      'handoff_to_human',
      'offer_choices',
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
    // One request only: a refusal is not retried.
    const t = await setup([() => ({ content: [], stop_reason: 'refusal' })]);
    const events: BackofficeEvent[] = [];
    t.backoffice.bus.subscribe(EventBus.key('acme', '351911111111'), (e) => events.push(e));
    await t.send('Olá');
    const [conv] = await t.db.select().from(conversations);
    expect(conv?.status).toBe('human');
    expect(events).toContainEqual({ type: 'conversation', status: 'human' });
    const runs = await t.db.select().from(agentRuns);
    expect(runs[0]?.error).toMatch(/refusal/);
  }, 15_000);
});

describe('ClaudeResponder with the product tools', () => {
  it('searches the synced catalogue and sends product cards after the reply', async () => {
    const client = shopClient({ tools: agentTools.map((t) => t.name) });
    const t = await setup(
      [
        callTool('search_products', { query: 'pavimento', use: 'casa de banho' }),
        (body) => {
          const result = JSON.stringify((body.messages as unknown[]).at(-1));
          expect(result).toContain(V.vinyl);
          return callTool('show_products', { variant_ids: [V.vinyl] })(body);
        },
        say('Para casa de banho recomendo este vinílico SPC, resistente à água.'),
      ],
      { client, registry: agentTools },
    );
    await seedCatalogue(t.db, client);
    await t.send('Preciso de pavimento para uma casa de banho');
    const out = await t.outbound();
    expect(out.map((m) => m.type)).toEqual(['text', 'image']);
    expect(out[0]?.text).toMatch(/vinílico/);
  });
});

describe('ClaudeResponder across turns', () => {
  it('still knows the variant id when the customer confirms the cart a turn later', async () => {
    const client = shopClient({ tools: agentTools.map((t) => t.name) });
    const t = await setup(
      [
        callTool('search_products', { query: 'pavimento vinílico' }),
        say('O vinílico SPC custa X por caixa. Confirma 2 caixas?'),
        (body) => {
          const system = (body.messages as { role: string; content: unknown }[]).filter(
            (m) => m.role === 'system',
          );
          // The earlier search result, with its variant id, is replayed before the earlier reply.
          expect(String(system[0]!.content)).toContain(V.vinyl);
          return callTool('create_checkout_link', {
            items: [{ variant_id: V.vinyl, quantity: 2 }],
          })(body);
        },
        (body) => {
          expect(JSON.stringify((body.messages as unknown[]).at(-1))).toContain(
            `/cart/${V.vinyl}:2`,
          );
          return say('Aqui está o link para finalizar a compra.')(body);
        },
      ],
      { client, registry: agentTools },
    );
    await seedCatalogue(t.db, client);
    await t.send('Queria pavimento vinílico');
    await t.send('Sim, confirmo');
    expect(t.requests).toHaveLength(4);
  });
});

describe('ClaudeResponder handoff and order drafts', () => {
  const weekdays = ['09:00-13:00', '14:00-18:00'];
  const client = testClient({
    branches: [
      {
        ...testClient().branches[0]!,
        hours: { mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays },
        lead_emails: ['lisboa@example.invalid'],
      },
    ],
  });

  it('hands over at 22:00, says when the team replies, then stays silent until handed back', async () => {
    const t = await setup(
      [
        callTool('handoff_to_human', {
          reason: 'customer_asked',
          summary: 'Quer falar com alguém sobre um deck.',
        }),
        (body) => {
          const result = JSON.stringify((body.messages as unknown[]).at(-1));
          expect(result).toContain('tomorrow (Wednesday) at 09:00');
          return say('Um colega responde-lhe amanhã a partir das 9:00.')(body);
        },
        say('Olá de novo! Em que posso ajudar?'),
      ],
      { client, now: new Date('2026-10-20T21:00:00Z') }, // Tuesday 22:00 in Lisbon
    );
    const events: BackofficeEvent[] = [];
    t.backoffice.bus.subscribe(EventBus.key('acme', '351911111111'), (e) => events.push(e));

    await t.send('Quero falar com alguém');
    expect((await t.outbound()).map((m) => m.text)).toEqual([
      'Um colega responde-lhe amanhã a partir das 9:00.',
    ]);
    const [email] = await t.db.select().from(outbox);
    expect(email).toMatchObject({ kind: 'handoff', to: ['lisboa@example.invalid'] });
    expect(events).toContainEqual({ type: 'conversation', status: 'human' });

    // In human status the bot does not answer, and Claude is not called.
    await t.send('Está aí alguém?');
    expect(await t.outbound()).toHaveLength(1);
    expect(t.requests).toHaveLength(2);

    // The back-office hands the conversation back to the bot.
    const back = await t.app.request('/sim/acme/conversation/bot?phone=351911111111', {
      method: 'POST',
    });
    expect(back.status).toBe(204);
    const [conv] = await t.db.select().from(conversations);
    expect(conv?.status).toBe('bot');
    expect(events.at(-1)).toEqual({ type: 'conversation', status: 'bot' });
    await t.send('Olá');
    expect(await t.outbound()).toHaveLength(2);
  });

  it('answers 404 to return-to-bot without an open conversation', async () => {
    const t = await setup([]);
    const res = await t.app.request('/sim/acme/conversation/bot?phone=351922222222', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const bad = await t.app.request('/sim/nope/conversation/bot?phone=351922222222', {
      method: 'POST',
    });
    expect(bad.status).toBe(404);
  });

  it('turns a special-transport cart into an order draft instead of a checkout link', async () => {
    const shop = shopClient({ tools: agentTools.map((x) => x.name) });
    const t = await setup(
      [
        callTool('create_checkout_link', { items: [{ variant_id: V.beam, quantity: 2 }] }),
        (body) => {
          const result = JSON.stringify((body.messages as unknown[]).at(-1));
          expect(result).toContain('needs_order_draft');
          return callTool('send_order_draft', {
            items: [{ variant_id: V.beam, quantity: 2 }],
            reason: 'special_transport',
            fulfilment: 'delivery',
            delivery_address: 'Rua das Flores 1, 8000-000 Faro',
            summary: '2 vigas GL24h de 12 m, entrega em Faro.',
          })(body);
        },
        (body) => {
          const result = JSON.stringify((body.messages as unknown[]).at(-1));
          expect(result).not.toContain('is_error');
          expect(result).toContain('products_subtotal_eur');
          return say(
            'Passei a sua encomenda à equipa, que vai confirmar o preço final e o transporte.',
          )(body);
        },
      ],
      { client: shop, registry: agentTools },
    );
    await seedCatalogue(t.db, shop);
    await t.send('Confirmo as 2 vigas, entrega em Faro');

    const out = await t.outbound();
    expect(out).toHaveLength(1);
    expect(out[0]?.text).not.toContain('/cart/');
    const [lead] = await t.db.select().from(leads);
    expect(lead).toMatchObject({ type: 'order' });
    const [email] = await t.db.select().from(outbox);
    expect(email?.kind).toBe('order_draft');
    const [run] = await t.db.select().from(agentRuns);
    expect((run?.toolCalls as { name: string; ok: boolean }[]).map((c) => [c.name, c.ok])).toEqual([
      ['create_checkout_link', false],
      ['send_order_draft', true],
    ]);
  });
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
