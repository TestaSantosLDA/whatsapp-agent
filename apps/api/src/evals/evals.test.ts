import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { agentTools } from '../agent/registry.js';
import { syncCatalogue } from '../catalogue/sync.js';
import { parseClientConfig } from '../clients/registry.js';
import { products } from '../db/schema.js';
import { testDb } from '../test/catalogue.js';
import {
  evalsRoot,
  loadEvalSet,
  matches,
  parseCaseFile,
  parseRegexLiteral,
  repoRoot,
  useCases,
} from './cases.js';
import { runChecks, type Transcript } from './checks.js';
import { confirmRun, main, type CliDeps } from './cli.js';
import { estimateRunCost } from './cost.js';
import { buildReport, percentile, renderComparison, type EvalReport } from './report.js';
import { prepareClient, snapshotPath, snapshotSource } from './runner.js';

const jularPath = join(repoRoot, 'clients', 'jular.yaml');
const jular = parseClientConfig(readFileSync(jularPath, 'utf8'), jularPath);
const set = loadEvalSet('jular');

describe('the Jular eval set', () => {
  it('has 36 to 45 valid cases covering every use case in both languages', () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(36);
    expect(set.cases.length).toBeLessThanOrEqual(45);
    for (const useCase of useCases) {
      const langs = new Set(set.cases.filter((c) => c.use_case === useCase).map((c) => c.language));
      expect([useCase, [...langs].sort()]).toEqual([useCase, ['en', 'pt-PT']]);
    }
  });

  it('only names real tools, branches, email kinds and valid patterns', () => {
    const tools = new Set([...agentTools.map((t) => t.name), 'offer_choices', 'handoff_to_human']);
    const branches = new Set(jular.branches.map((b) => b.id));
    for (const c of set.cases) {
      for (const t of [...c.checks.tools_called, ...c.checks.tools_not_called]) {
        expect(tools, `${c.id}: ${t}`).toContain(t);
      }
      if (c.checks.lead && c.checks.lead !== 'none' && c.checks.lead.branch) {
        expect(branches, c.id).toContain(c.checks.lead.branch);
      }
      for (const kind of c.checks.emails)
        expect(['lead', 'handoff', 'order_draft']).toContain(kind);
      for (const n of c.checks.silent_turns) expect(n).toBeLessThanOrEqual(c.turns.length);
      expect(Number.isNaN(new Date(c.now).getTime()), c.id).toBe(false);
    }
  });

  it('rejects a malformed case file with the path of the problem', () => {
    expect(() =>
      parseCaseFile(
        '- id: Bad Id\n  title: x\n  use_case: nope\n  language: pt-PT\n  now: yesterday\n  turns: []\n  rubric: short\n',
        'bad.yaml',
      ),
    ).toThrow(/bad\.yaml[\s\S]*0\.id[\s\S]*0\.use_case[\s\S]*0\.now/);
    expect(() =>
      parseCaseFile(
        `- id: ok\n  title: x\n  use_case: faq\n  language: en\n  now: '2026-10-20T10:00:00+01:00'\n  turns: [Hi]\n  checks: { must_include: ['/(unclosed/'] }\n  rubric: A rubric long enough to pass.\n`,
        'bad-regex.yaml',
      ),
    ).toThrow(/invalid \/regex\//);
  });

  it('checks facts that are true in the catalogue snapshot', async () => {
    const handle = await testDb();
    try {
      const client = prepareClient(jular, { setup: set.setup });
      const result = await syncCatalogue({
        db: handle.db,
        client,
        source: snapshotSource('https://loja.jular.pt', snapshotPath(set.dir, set.setup)),
      });
      expect(result).toMatchObject({ ok: true, total: 25 });
      const rows = await handle.db.select().from(products);
      const byVariant = new Map(rows.map((r) => [r.variantId, r]));
      // Every cart link a case expects points at an available, normal-transport variant.
      for (const c of set.cases) {
        for (const p of c.checks.must_include) {
          const id = /cart\\?\/(\d+)/.exec(p)?.[1];
          if (!id) continue;
          const row = byVariant.get(id);
          expect(row, `${c.id}: ${id}`).toBeDefined();
          expect(row!.available).toBe(true);
          expect(row!.tags).not.toContain('Transporte Especial');
        }
      }
      expect(byVariant.get('46100000000022')?.available).toBe(false); // 20 mm oak
      expect(byVariant.get('46100000000051')?.tags).toContain('Transporte Especial');
      expect(byVariant.get('46100000000141')?.price).toBe('54413.97'); // Treehouse Spot T1A
      expect(byVariant.get('46100000000011')?.extra).toMatchObject({ m2_per_box: 2.2 });
      expect(byVariant.get('46100000000201')?.extra).toEqual({}); // ripado: no m² data
    } finally {
      await handle.close();
    }
  });
});

describe('deterministic checks', () => {
  it('matches substrings and /regex/ literals ignoring case', () => {
    expect(matches('mb way', 'Aceitamos MB Way.')).toBe(true);
    expect(matches('/\\b10 caixas/', 'Precisa de 10 caixas.')).toBe(true);
    expect(matches('/\\b10 caixas/', 'Precisa de 110 caixas.')).toBe(false);
    expect(matches('/CART\\/46:10/', 'https://x/cart/46:10')).toBe(true);
    expect(parseRegexLiteral('plain')).toBeNull();
    expect(parseRegexLiteral('/a/m')?.flags).toBe('im');
  });

  const transcript: Transcript = {
    turns: [
      {
        customer: 'Quero falar com uma pessoa',
        replies: ['Um colega responde-lhe em breve.'],
        toolCalls: [{ name: 'handoff_to_human', ok: true }],
        latencyMs: 1200,
        costUsd: 0.01,
      },
      { customer: 'Olá?', replies: [], toolCalls: [], latencyMs: 0, costUsd: 0 },
    ],
    status: 'human',
    leads: [{ type: 'handoff', branchId: 'camarate' }],
    emails: [{ kind: 'handoff', to: ['camarate@example.invalid'] }],
  };

  it('passes every check the conversation meets', () => {
    const results = runChecks(
      {
        tools_called: ['handoff_to_human'],
        tools_not_called: ['save_lead'],
        must_include: ['colega', '/em breve/'],
        must_not_include: ['banheiro'],
        lead: { type: 'handoff', branch: 'camarate' },
        status: 'human',
        emails: ['handoff'],
        silent_turns: [2],
      },
      transcript,
    );
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(results).toHaveLength(9);
  });

  it('fails each kind of check with a useful detail', () => {
    const results = runChecks(
      {
        tools_called: ['save_lead'],
        tools_not_called: ['handoff_to_human'],
        must_include: ['MB Way'],
        must_not_include: ['/colega/'],
        lead: { type: 'quote' },
        status: 'bot',
        emails: ['lead'],
        silent_turns: [1],
      },
      transcript,
    );
    expect(results.every((r) => !r.pass)).toBe(true);
    expect(results.find((r) => r.name === 'tools_called: save_lead')?.detail).toBe(
      'called: handoff_to_human',
    );
    expect(results.find((r) => r.name === 'must_not_include: /colega/')?.detail).toContain(
      'Um colega',
    );
    expect(results.find((r) => r.name === 'lead: quote')?.detail).toBe('stored: handoff@camarate');
    expect(results.find((r) => r.name === 'status: bot')?.detail).toBe('was human');
  });

  it('treats "lead: none" as no lead other than a handoff, and failed turns as failures', () => {
    const none = runChecks({ ...emptyChecks(), lead: 'none' }, transcript);
    expect(none).toEqual([{ name: 'lead: none', pass: true, detail: undefined }]);
    const failed = runChecks(emptyChecks(), {
      ...transcript,
      turns: [{ ...transcript.turns[0]!, error: 'agent failed: boom' }],
    });
    expect(failed).toEqual([{ name: 'turn 1 error', pass: false, detail: 'agent failed: boom' }]);
  });
});

function emptyChecks() {
  return {
    tools_called: [],
    tools_not_called: [],
    must_include: [],
    must_not_include: [],
    emails: [],
    silent_turns: [],
  };
}

type Step = Record<string, unknown>;

/**
 * A scripted Anthropic API. Grader requests (structured output) and agent requests are told
 * apart by `output_config.format`; agent replies are chosen from the customer's latest words.
 */
function fakeAnthropic() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const reply = (body: Record<string, unknown>): Step => {
    const format = (body.output_config as { format?: unknown } | undefined)?.format;
    const text = JSON.stringify(body.messages);
    if (format) {
      return text.includes('calc-vinyl') || text.includes('Caixas de vinílico')
        ? say(JSON.stringify({ reason: 'Correct figures but no accessory hints.', pass: false }))
        : say(JSON.stringify({ reason: 'Handed over politely and at once.', pass: true }));
    }
    const msgs = body.messages as { role: string; content: unknown }[];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const afterTool = JSON.stringify(lastUser?.content).includes('tool_result');
    if (text.includes('vinílico SPC')) {
      return afterTool
        ? say('Para 20 m² precisa de *10 caixas* (22 m²), total 249,00 € com IVA.')
        : {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_calc',
                name: 'calculate_quantity',
                input: { variant_id: '46100000000011', rooms: '4 x 5' },
              },
            ],
            stop_reason: 'tool_use',
          };
    }
    // The customer asked for a person: the agent "forgets" the tool; the responder hands over.
    return say('Claro, um colega da Jular vai responder-lhe aqui em breve.');
  };
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          stop_sequence: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 0,
          },
          ...reply(body),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { anthropic, requests };
}

function say(text: string): Step {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cliDeps(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let built = 0;
  const fake = fakeAnthropic();
  const reportsDir = mkdtempSync(join(tmpdir(), 'wa-evals-'));
  tmpDirs.push(reportsDir);
  const deps: CliDeps = {
    env: { ANTHROPIC_API_KEY: 'test-key' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    interactive: false,
    ask: async () => 'n',
    anthropic: () => {
      built++;
      return fake.anthropic;
    },
    reportsDir,
    now: () => new Date('2026-10-22T10:00:00Z'),
    ...overrides,
  };
  return { deps, out, err, fake, reportsDir, built: () => built };
}

describe('pnpm eval', () => {
  it('plays two cases through the real agent, grades them and writes the report', async () => {
    const t = cliDeps();
    const code = await main(
      [
        '--client',
        'jular',
        '--model',
        'claude-haiku-5-5',
        '--case',
        'calc-vinyl-room-pt,handoff-ask-person-pt',
        '--concurrency',
        '1',
        '--yes',
      ],
      t.deps,
    );
    expect(t.err).toEqual([]);
    expect(code).toBe(0);
    expect(t.out[0]).toMatch(/Eval jular on claude-haiku-5-5 .*grader claude-opus-5-5/);
    expect(t.out.join('\n')).toMatch(/Estimated cost: \$/);

    // Agent requests use the overridden model; grader requests the grader with a JSON schema.
    const agent = t.fake.requests.filter((r) => !(r.body.output_config as Step).format);
    const grader = t.fake.requests.filter((r) => (r.body.output_config as Step).format);
    expect(new Set(agent.map((r) => r.body.model))).toEqual(new Set(['claude-haiku-5-5']));
    expect(grader.map((r) => r.body.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
    expect((grader[0]!.body.output_config as { format: { type: string } }).format.type).toBe(
      'json_schema',
    );

    const files = readdirSync(t.reportsDir).sort();
    expect(files).toEqual([
      'jular-claude-haiku-5-5-2026-10-22T10-00-00Z.json',
      'jular-claude-haiku-5-5-2026-10-22T10-00-00Z.md',
    ]);
    const report = JSON.parse(readFileSync(join(t.reportsDir, files[0]!), 'utf8')) as EvalReport;
    expect(report).toMatchObject({
      client: 'jular',
      model: 'claude-haiku-5-5',
      graderModel: 'claude-opus-5-5',
      catalogue: 'snapshot',
      totals: { cases: 2, passed: 1, failed: 1, passRate: 0.5, turns: 2 },
      byUseCase: {
        calculator: { cases: 1, passed: 0, passRate: 0 },
        handoff: { cases: 1, passed: 1, passRate: 1 },
      },
    });
    expect(report.totals.agentCostUsd).toBeGreaterThan(0);
    expect(report.totals.graderCostUsd).toBeGreaterThan(0);
    expect(report.totals.latencyMs.p95).toBeGreaterThanOrEqual(report.totals.latencyMs.p50);

    const [calc, handoff] = report.cases;
    // The deterministic checks pass; the grader fails the case.
    expect(calc).toMatchObject({ id: 'calc-vinyl-room-pt', passed: false });
    expect(calc!.checks.every((c) => c.pass)).toBe(true);
    expect(calc!.grade).toMatchObject({ pass: false, reason: expect.stringMatching(/accessory/) });
    expect(calc!.transcript.turns[0]!.toolCalls).toEqual([
      expect.objectContaining({ name: 'calculate_quantity', ok: true }),
    ]);
    expect(handoff).toMatchObject({
      id: 'handoff-ask-person-pt',
      passed: true,
      transcript: {
        status: 'human',
        leads: [{ type: 'handoff', branchId: 'camarate' }],
        emails: [{ kind: 'handoff', to: ['camarate@example.invalid'] }],
      },
    });

    const md = readFileSync(join(t.reportsDir, files[1]!), 'utf8');
    expect(md).toContain('# Eval report: jular on claude-haiku-5-5');
    expect(md).toContain('**Passed 1/2 (50%)**');
    expect(md).toMatch(/\| calculator \| 0\/1 \| 0% \|/);
    expect(md).toMatch(/\| calc-vinyl-room-pt \| calculator \| pt-PT \| \*\*FAIL\*\* \|/);
    expect(md).toContain('Correct figures but no accessory hints.');
    expect(md).toContain('> Para 20 m² precisa de *10 caixas* (22 m²), total 249,00 € com IVA.');
  }, 60_000);

  it('exits without calling the API when there is no ANTHROPIC_API_KEY', async () => {
    const t = cliDeps({ env: {} });
    const code = await main(['--client', 'jular', '--yes'], t.deps);
    expect(code).toBe(1);
    expect(t.out.join('\n')).toMatch(/Estimated cost: \$\d/);
    expect(t.err.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(t.built()).toBe(0);
    expect(t.fake.requests).toHaveLength(0);
  });

  it('refuses a model without a price unless --allow-unknown-cost is passed', async () => {
    const t = cliDeps();
    const args = ['--client', 'jular', '--model', 'claude-unknown-9', '--yes'];
    expect(await main(args, t.deps)).toBe(1);
    expect(t.err.join('\n')).toMatch(/--allow-unknown-cost/);
    expect(t.built()).toBe(0);
    expect(t.fake.requests).toHaveLength(0);
  });

  it('needs --yes or an interactive "y" before spending money', async () => {
    const noTerminal = cliDeps();
    expect(await main(['--client', 'jular'], noTerminal.deps)).toBe(1);
    expect(noTerminal.err.join('\n')).toMatch(/pass --yes/);
    expect(noTerminal.built()).toBe(0);

    const asked: string[] = [];
    const declined = cliDeps({
      interactive: true,
      ask: async (q) => {
        asked.push(q);
        return '';
      },
    });
    expect(await main(['--client', 'jular', '--case', 'faq-returns-en'], declined.deps)).toBe(1);
    expect(asked).toEqual(['Run it? [y/N] ']);
    expect(declined.err).toEqual(['Cancelled.']);
    expect(declined.fake.requests).toHaveLength(0);

    const ask = async () => 'y';
    expect(await confirmRun({ yes: false, interactive: true, ask })).toBe(true);
    expect(await confirmRun({ yes: false, interactive: false, ask })).toBe(false);
    expect(await confirmRun({ yes: true, interactive: false, ask })).toBe(true);
  });

  it('rejects unknown cases and a missing client', async () => {
    const t = cliDeps();
    expect(await main(['--client', 'jular', '--case', 'nope', '--yes'], t.deps)).toBe(2);
    expect(t.err.join('\n')).toMatch(/Unknown case id\(s\): nope/);
    expect(await main(['--yes'], t.deps)).toBe(2);
  });
});

describe('cost estimate and reports', () => {
  it('estimates more for Opus than for Haiku, and nothing for an unpriced model', () => {
    const opus = estimateRunCost({
      client: prepareClient(jular, { model: 'claude-opus-5-5' }),
      cases: set.cases,
      graderModel: 'claude-opus-5-5',
    });
    const haiku = estimateRunCost({
      client: prepareClient(jular, { model: 'claude-haiku-5-5' }),
      cases: set.cases,
      graderModel: 'claude-opus-5-5',
    });
    expect(opus.turns).toBe(set.cases.reduce((n, c) => n + c.turns.length, 0));
    expect(opus.promptTokens).toBeGreaterThan(3000);
    expect(opus.agentUsd!).toBeGreaterThan(haiku.agentUsd! * 10);
    expect(opus.graderUsd).toBe(haiku.graderUsd);
    const unknown = estimateRunCost({
      client: prepareClient(jular, { model: 'claude-unknown' }),
      cases: set.cases,
      graderModel: null,
    });
    expect(unknown).toMatchObject({ agentUsd: undefined, graderUsd: 0, totalUsd: undefined });
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('compares reports side by side', () => {
    const base = {
      client: 'jular',
      graderModel: 'claude-opus-5-5',
      catalogue: 'snapshot' as const,
      startedAt: new Date('2026-10-22T10:00:00Z'),
      finishedAt: new Date('2026-10-22T10:05:00Z'),
    };
    const result = (id: string, passed: boolean) => ({
      id,
      title: id,
      use_case: 'faq' as const,
      language: 'en' as const,
      passed,
      checks: [],
      transcript: { turns: [], status: 'bot', leads: [], emails: [] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      costUsd: 0.02,
    });
    const a = buildReport({
      ...base,
      model: 'claude-opus-5-5',
      cases: [result('x', true), result('y', true)],
    });
    const b = buildReport({
      ...base,
      model: 'claude-haiku-5-5',
      cases: [result('x', true), result('y', false)],
    });
    const table = renderComparison([a, b]);
    expect(table).toContain('| | claude-opus-5-5 | claude-haiku-5-5 |');
    expect(table).toContain('| Pass rate | 2/2 (100%) | 1/2 (50%) |');
    expect(table).toContain('| Cost per conversation | $0.0200 | $0.0200 |');
    expect(table).toContain('| faq | 2/2 (100%) | 1/2 (50%) |');
    expect(table).toContain('| y | pass | FAIL |');
  });
});

it('keeps eval files under the repo evals folder', () => {
  expect(set.dir).toBe(join(evalsRoot, 'jular'));
});
