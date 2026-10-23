import Anthropic from '@anthropic-ai/sdk';
import {
  applyClientSettings,
  clientSettingsOf,
  diffClientSettings,
  type AdminSettingsView,
} from '@wa/shared';
import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeResponder } from '../../agent/claude-responder.js';
import { agentTools } from '../../agent/registry.js';
import { outbox } from '../../db/schema.js';
import type { Responder } from '../../jobs/process-conversation.js';
import { adminTestApp } from '../../test/admin.js';
import { testClient } from '../../test/helpers.js';

type Step = () => Record<string, unknown>;

/** Claude answering from a script, recording each request's system prompt. */
function fakeClaude(script: Step[]) {
  const systems: string[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { system: { text: string }[] };
      systems.push(body.system[0]!.text);
      const step = script[systems.length - 1];
      if (!step) throw new Error(`unexpected request #${systems.length}`);
      return Response.json({
        id: `msg_${systems.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        ...step(),
      });
    },
  });
  return { anthropic, systems };
}

const saveLead: Step = () => ({
  content: [
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'save_lead',
      input: { request_type: 'quote', summary: 'Deck de 30 m².', location: 'Lisboa' },
    },
  ],
  stop_reason: 'tool_use',
});
const say =
  (text: string): Step =>
  () => ({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });

let current: Awaited<ReturnType<typeof adminTestApp>> | undefined;
afterEach(async () => {
  await current?.queue.drain();
  await current?.close();
  current = undefined;
});

const client = testClient({
  tools: ['save_lead'],
  branches: [{ ...testClient().branches[0]!, lead_emails: ['antes@example.invalid'] }],
});

describe('settings take effect without a restart', () => {
  it('sends the next lead to the new recipients and rebuilds the cached prompt', async () => {
    const claude = fakeClaude([
      saveLead,
      say('Registado: a equipa contacta-o em um dia útil.'),
      saveLead,
      say('Registado: a equipa contacta-o em duas horas.'),
    ]);
    const lazy: Responder = {
      respond: (input) => responder.respond(input),
      invalidate: (id) => responder.invalidate(id),
    };
    const t = await adminTestApp({ clients: [client], responder: lazy });
    current = t;
    const responder = new ClaudeResponder({
      db: t.db,
      anthropic: claude.anthropic,
      tools: agentTools,
      backoffice: t.backoffice,
      now: () => new Date('2026-10-19T10:30:00Z'),
    });
    const send = async (text: string) => {
      await t.app.request('/sim/acme/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '351911111111', name: 'Ana', text }),
      });
      await t.queue.drain();
    };

    await send('Queria um orçamento para um deck');

    // An admin changes the branch's recipients and the response time in Settings.
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const url = '/api/admin/clients/acme/settings';
    const { settings } = (await (await t.call(url, admin.token)).json()) as AdminSettingsView;
    settings.branches[0]!.lead_emails = ['depois@example.invalid', 'chefe@example.invalid'];
    settings.response_time = 'duas horas';
    const res = await t.call(url, admin.token, { method: 'PUT', body: JSON.stringify(settings) });
    expect(res.status).toBe(200);

    await send('E outro para um pavimento');

    const emails = await t.db.select().from(outbox).orderBy(asc(outbox.createdAt));
    expect(emails.map((e) => e.to)).toEqual([
      ['antes@example.invalid'],
      ['depois@example.invalid', 'chefe@example.invalid'],
    ]);
    expect(emails[1]!.body).toContain('duas horas');
    expect(claude.systems[0]).toContain('within um dia útil');
    expect(claude.systems[1]).toBe(claude.systems[0]); // cached within a turn
    expect(claude.systems[2]).toContain('within duas horas');
    expect(claude.systems[2]).not.toContain('um dia útil');
  });

  it('invalidates the responder when the registry changes', async () => {
    const invalidated: string[] = [];
    const responder: Responder = {
      respond: async () => [],
      invalidate: (id) => invalidated.push(id),
    };
    const t = await adminTestApp({ clients: [client], responder });
    current = t;
    t.clients.setOverrides('acme', { response_time: 'já' });
    expect(invalidated).toEqual(['acme']);
  });
});

describe('settings overrides (shared)', () => {
  it('round-trips: the diff of the edited settings reproduces them on the file config', () => {
    const edited = clientSettingsOf(client);
    edited.handoff_triggers = ['Obras públicas'];
    edited.response_time_hours = 4;
    edited.branches[0]!.hours = { tue: ['09:00-12:00'], mon: ['09:00-18:00'] };
    const overrides = diffClientSettings(client, edited);
    expect(overrides).toEqual({
      response_time_hours: 4,
      handoff_triggers: ['Obras públicas'],
      branches: { lisboa: { hours: { mon: ['09:00-18:00'], tue: ['09:00-12:00'] } } },
    });
    expect(clientSettingsOf(applyClientSettings(client, overrides))).toEqual({
      ...edited,
      branches: [{ ...edited.branches[0]!, hours: { mon: ['09:00-18:00'], tue: ['09:00-12:00'] } }],
    });
    expect(diffClientSettings(client, clientSettingsOf(client))).toEqual({});
  });

  it('ignores overrides for branches the file no longer has', () => {
    const merged = applyClientSettings(client, { branches: { gone: { lead_emails: ['x@y.z'] } } });
    expect(merged.branches).toEqual(client.branches);
  });
});
