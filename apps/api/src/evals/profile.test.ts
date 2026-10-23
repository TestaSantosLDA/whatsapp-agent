/**
 * WA-027 eval support: a case can play earlier conversations with the same customer first, and
 * check the profile and that the replies got shorter. Played through the real agent with a
 * scripted Claude (no API key, no cost).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { parseClientConfig } from '../clients/registry.js';
import { loadEvalSet, parseCaseFile, repoRoot } from './cases.js';
import { runChecks, type Transcript } from './checks.js';
import { renderTranscript } from './grader.js';
import { prepareClient, runCases, snapshotPath, snapshotSource } from './runner.js';

const jularPath = join(repoRoot, 'clients', 'jular.yaml');
const jular = parseClientConfig(readFileSync(jularPath, 'utf8'), jularPath);
const set = loadEvalSet('jular');

type Body = Record<string, unknown>;

const LONG =
  'O Deck de Pinho Tratado Autoclave de 27 mm custa 18,90 € por unidade, com IVA. É tratado em autoclave, por isso resiste bem à humidade e aos fungos, e recomendamos um óleo de manutenção uma vez por ano. Quer que calcule a quantidade?';

/** Claude for the agent: reads the customer's latest words and the turn's context. */
function scriptedClaude() {
  const contexts: string[] = [];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      const msgs = body.messages as { role: string; content: unknown }[];
      const system = [...msgs].reverse().find((m) => m.role === 'system');
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const said = JSON.stringify(lastUser?.content);
      contexts.push(String(system?.content));
      let reply: Body;
      if (said.includes('tool_result')) {
        reply = { content: [{ type: 'text', text: LONG }], stop_reason: 'end_turn' };
      } else if (said.includes('Levo normalmente')) {
        reply = {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_note',
              name: 'note_profile',
              input: {
                detail_level: 'short',
                usual_products: [
                  {
                    name: 'Deck de Pinho Tratado Autoclave 27 mm',
                    variant_id: '46100000000071',
                    quantity: '60 m²',
                  },
                ],
                delivery: 'site',
                evidence: 'só preciso do preço',
              },
            },
          ],
          stop_reason: 'tool_use',
        };
      } else if (String(system?.content).includes('detail_level: short')) {
        reply = {
          content: [
            { type: 'text', text: '18,90 € com IVA. Os 60 m² do costume, com entrega na obra?' },
          ],
          stop_reason: 'end_turn',
        };
      } else {
        reply = { content: [{ type: 'text', text: LONG }], stop_reason: 'end_turn' };
      }
      return Response.json({
        id: `msg_${contexts.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
        ...reply,
      });
    },
  });
  return { anthropic, contexts };
}

describe('eval cases with earlier conversations (WA-027)', () => {
  it('plays the earlier conversation, then serves the returning customer from the profile', async () => {
    const evalCase = set.cases.find((c) => c.id === 'profile-contractor-returns-pt')!;
    expect(evalCase.earlier).toHaveLength(1);
    const claude = scriptedClaude();
    const client = prepareClient(jular, { setup: set.setup });
    const [result] = await runCases({
      client,
      cases: [{ ...evalCase, checks: { ...evalCase.checks, tools_called: [], must_include: [] } }],
      anthropic: claude.anthropic,
      graderModel: null,
      source: snapshotSource('https://loja.jular.pt', snapshotPath(set.dir, set.setup)),
      setup: set.setup,
      concurrency: 1,
    });
    expect(result!.error).toBeUndefined();
    expect(result!.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result!.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'profile: detail_level',
        'profile: usual_products',
        'shorter_than_earlier',
      ]),
    );
    expect(result!.passed).toBe(true);
    const t = result!.transcript;
    expect(t.earlier).toHaveLength(1);
    expect(t.earlier![0]!.map((x) => x.toolCalls.map((c) => c.name))).toEqual([
      [],
      ['note_profile'],
    ]);
    expect(t.turns).toHaveLength(1);
    expect(t.profile).toEqual(
      expect.arrayContaining([
        { field: 'detail_level', value: 'short', source: 'agent', evidence: 'só preciso do preço' },
      ]),
    );
    // The new conversation's context carried the profile; the first one did not.
    expect(claude.contexts[0]).not.toContain('service preferences');
    expect(claude.contexts.at(-1)).toContain(
      '- detail_level: short (they said "só preciso do preço")',
    );
    const text = renderTranscript(t);
    expect(text).toContain('=== Earlier conversation 1 with the same customer');
    expect(text).toContain('Customer profile at the end: ');
  }, 60_000);

  it('fails the checks when the profile is missing or the replies did not get shorter', () => {
    const turn = (replies: string[]) => ({
      customer: 'x',
      replies,
      toolCalls: [],
      latencyMs: 1,
      costUsd: 0,
    });
    const t: Transcript = {
      turns: [turn(['a much longer reply than before, with all the background'])],
      earlier: [[turn(['short'])]],
      status: 'bot',
      leads: [],
      emails: [],
      profile: [{ field: 'delivery', value: 'site', source: 'agent', evidence: 'na obra' }],
    };
    const [c] = parseCaseFile(
      `- id: x\n  title: x\n  use_case: profile\n  language: en\n  now: '2026-10-20T10:00:00+01:00'\n  earlier: [{ now: '2026-10-10T10:00:00+01:00', turns: [Hi] }]\n  turns: [Hi]\n  checks: { profile: [detail_level, delivery], shorter_than_earlier: true }\n  rubric: A rubric long enough to pass.\n`,
      'x.yaml',
    );
    const results = runChecks(c!.checks, t);
    expect(results).toEqual([
      { name: 'profile: detail_level', pass: false, detail: 'profile: delivery' },
      { name: 'profile: delivery', pass: true, detail: undefined },
      { name: 'shorter_than_earlier', pass: false, detail: 'mean reply 56 chars, earlier 5' },
    ]);
  });
});
