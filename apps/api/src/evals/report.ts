/** Eval reports (WA-019): totals, the Markdown and JSON files, and the side-by-side comparison. */
import type { CaseResult } from './runner.js';

export interface EvalReport {
  client: string;
  model: string;
  graderModel: string | null;
  catalogue: 'snapshot' | 'live';
  startedAt: string;
  finishedAt: string;
  totals: {
    cases: number;
    passed: number;
    failed: number;
    passRate: number;
    agentCostUsd: number;
    graderCostUsd: number;
    costPerConversationUsd: number;
    turns: number;
    /** Per agent turn, from the customer's message to the last reply sent. */
    latencyMs: { p50: number; p95: number };
    tokens: { input: number; output: number; cacheRead: number };
  };
  byUseCase: Record<string, { cases: number; passed: number; passRate: number }>;
  cases: CaseResult[];
}

/** Nearest-rank percentile; 0 for no values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function buildReport(meta: {
  client: string;
  model: string;
  graderModel: string | null;
  catalogue: 'snapshot' | 'live';
  startedAt: Date;
  finishedAt: Date;
  cases: CaseResult[];
}): EvalReport {
  const { cases } = meta;
  const passed = cases.filter((c) => c.passed).length;
  const agentCostUsd = sum(cases.map((c) => c.costUsd));
  const latencies = cases.flatMap((c) =>
    c.transcript.turns.filter((t) => t.latencyMs > 0).map((t) => t.latencyMs),
  );
  const byUseCase: EvalReport['byUseCase'] = {};
  for (const c of cases) {
    const u = (byUseCase[c.use_case] ??= { cases: 0, passed: 0, passRate: 0 });
    u.cases++;
    if (c.passed) u.passed++;
  }
  for (const u of Object.values(byUseCase)) u.passRate = u.passed / u.cases;
  return {
    client: meta.client,
    model: meta.model,
    graderModel: meta.graderModel,
    catalogue: meta.catalogue,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    totals: {
      cases: cases.length,
      passed,
      failed: cases.length - passed,
      passRate: cases.length ? passed / cases.length : 0,
      agentCostUsd: round6(agentCostUsd),
      graderCostUsd: round6(sum(cases.map((c) => c.grade?.costUsd ?? 0))),
      costPerConversationUsd: round6(cases.length ? agentCostUsd / cases.length : 0),
      turns: sum(cases.map((c) => c.transcript.turns.length)),
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      tokens: {
        input: sum(cases.map((c) => c.usage.inputTokens)),
        output: sum(cases.map((c) => c.usage.outputTokens)),
        cacheRead: sum(cases.map((c) => c.usage.cacheReadTokens)),
      },
    },
    byUseCase,
    cases,
  };
}

/** `jular-claude-haiku-5-5-2026-10-22T10-30-00Z` */
export function reportBaseName(report: Pick<EvalReport, 'client' | 'model' | 'startedAt'>): string {
  const stamp = report.startedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${report.client}-${report.model}-${stamp}`;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function renderMarkdown(r: EvalReport): string {
  const t = r.totals;
  const lines = [
    `# Eval report: ${r.client} on ${r.model}`,
    '',
    `- Started ${r.startedAt}, finished ${r.finishedAt}`,
    `- Grader: ${r.graderModel ?? 'off'} · Catalogue: ${r.catalogue === 'live' ? 'live store' : 'synthetic snapshot'}`,
    `- **Passed ${t.passed}/${t.cases} (${pct(t.passRate)})**`,
    `- Agent cost ${usd(t.agentCostUsd)} (${usd(t.costPerConversationUsd)} per conversation) · grader ${usd(t.graderCostUsd)}`,
    `- Latency per turn: p50 ${sec(t.latencyMs.p50)}, p95 ${sec(t.latencyMs.p95)} (${t.turns} turns)`,
    `- Tokens: ${t.tokens.input} input, ${t.tokens.cacheRead} cache read, ${t.tokens.output} output`,
    '',
    '## By use case',
    '',
    '| Use case | Passed | Rate |',
    '| --- | --- | --- |',
    ...Object.entries(r.byUseCase).map(
      ([k, u]) => `| ${k} | ${u.passed}/${u.cases} | ${pct(u.passRate)} |`,
    ),
    '',
    '## Cases',
    '',
    '| Case | Use case | Lang | Result | Failed checks | Grader | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.cases.map((c) => {
      const failed = c.checks.filter((x) => !x.pass).map((x) => x.name);
      if (c.error) failed.push(`error: ${c.error}`);
      const grade = c.grade ? `${c.grade.pass ? 'pass' : 'FAIL'}: ${c.grade.reason}` : '–';
      return `| ${c.id} | ${c.use_case} | ${c.language} | ${c.passed ? 'pass' : '**FAIL**'} | ${cell(failed.join('; ')) || '–'} | ${cell(grade)} | ${usd(c.costUsd)} |`;
    }),
    '',
    '## Transcripts',
    '',
  ];
  for (const c of r.cases) {
    lines.push(
      `<details><summary>${c.passed ? 'pass' : 'FAIL'} · ${c.id}: ${escapeHtml(c.title)}</summary>`,
      '',
    );
    for (const x of c.checks.filter((x) => !x.pass)) {
      lines.push(`- failed \`${x.name}\`${x.detail ? `: ${x.detail}` : ''}`);
    }
    if (c.grade) lines.push(`- grader (${c.grade.pass ? 'pass' : 'fail'}): ${c.grade.reason}`);
    if (c.error) lines.push(`- error: ${c.error}`);
    lines.push('');
    c.transcript.turns.forEach((turn, i) => {
      lines.push(`**${i + 1}. Customer:** ${turn.customer}`, '');
      if (turn.toolCalls.length) {
        lines.push(
          `_tools: ${turn.toolCalls.map((x) => `${x.name}${x.ok ? '' : ' (failed)'}`).join(', ')}_`,
          '',
        );
      }
      if (turn.error) lines.push(`_turn error: ${turn.error}_`, '');
      if (!turn.replies.length) lines.push('> (no reply)', '');
      for (const reply of turn.replies) {
        lines.push(...reply.split('\n').map((l) => `> ${l}`), '');
      }
    });
    lines.push(
      `Status ${c.transcript.status} · leads: ${c.transcript.leads.map((l) => `${l.type}@${l.branchId}`).join(', ') || 'none'} · emails: ${c.transcript.emails.map((e) => e.kind).join(', ') || 'none'}`,
      '',
      '</details>',
      '',
    );
  }
  return lines.join('\n');
}

/** A side-by-side table of two or more reports, for choosing a model. */
export function renderComparison(reports: EvalReport[]): string {
  const head = `| | ${reports.map((r) => r.model).join(' | ')} |`;
  const sep = `| --- | ${reports.map(() => '---').join(' | ')} |`;
  const row = (label: string, f: (r: EvalReport) => string) =>
    `| ${label} | ${reports.map(f).join(' | ')} |`;
  const useCases = [...new Set(reports.flatMap((r) => Object.keys(r.byUseCase)))];
  const ids = [...new Set(reports.flatMap((r) => r.cases.map((c) => c.id)))];
  const caseResult = (r: EvalReport, id: string) => {
    const c = r.cases.find((x) => x.id === id);
    return !c ? '–' : c.passed ? 'pass' : 'FAIL';
  };
  return [
    head,
    sep,
    row('Pass rate', (r) => `${r.totals.passed}/${r.totals.cases} (${pct(r.totals.passRate)})`),
    row('Cost per conversation', (r) => usd(r.totals.costPerConversationUsd)),
    row('Agent cost (run)', (r) => usd(r.totals.agentCostUsd)),
    row('Latency p50', (r) => sec(r.totals.latencyMs.p50)),
    row('Latency p95', (r) => sec(r.totals.latencyMs.p95)),
    row('Grader', (r) => r.graderModel ?? 'off'),
    row('Run', (r) => r.startedAt),
    ...useCases.map((u) =>
      row(u, (r) => {
        const x = r.byUseCase[u];
        return x ? `${x.passed}/${x.cases} (${pct(x.passRate)})` : '–';
      }),
    ),
    '',
    `| Case | ${reports.map((r) => r.model).join(' | ')} |`,
    sep,
    ...ids.map((id) => `| ${id} | ${reports.map((r) => caseResult(r, id)).join(' | ')} |`),
  ].join('\n');
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
