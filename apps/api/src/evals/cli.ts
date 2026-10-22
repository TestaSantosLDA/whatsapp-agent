/**
 * `pnpm eval --client jular --model claude-haiku-5-5 [--case id[,id]] [--yes] [--concurrency 4]
 * [--grader claude-opus-5-5 | --no-grader] [--live-catalogue]`
 *
 * Plays the client's eval cases (evals/<client>/*.yaml) through the real agent and writes
 * evals/reports/<client>-<model>-<timestamp>.md and .json. Costs real API money: the estimate is
 * printed first and the run needs --yes or an interactive "y".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import type { ClientConfig } from '@wa/shared';
import { sourceForClient, type CatalogueSource } from '../catalogue/source.js';
import { parseClientConfig } from '../clients/registry.js';
import { loadDotEnv } from '../env.js';
import { evalsRoot, loadEvalSet, repoRoot } from './cases.js';
import { estimateRunCost, formatUsd } from './cost.js';
import { DEFAULT_GRADER_MODEL } from './grader.js';
import { buildReport, renderMarkdown, reportBaseName } from './report.js';
import { prepareClient, runCases, snapshotPath, snapshotSource } from './runner.js';

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Whether a person can answer the confirmation prompt. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  /** Builds the API client. Only called once the run is confirmed. */
  anthropic: (apiKey: string) => Anthropic;
  clientsDir?: string;
  evalsDir?: string;
  reportsDir?: string;
  /** Only for --live-catalogue; tests inject a fake store. */
  liveSource?: (client: ClientConfig) => CatalogueSource | undefined;
  now?: () => Date;
}

/** --yes, or a "y" typed at the prompt. Without a terminal and without --yes: no. */
export async function confirmRun(opts: {
  yes: boolean;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
}): Promise<boolean> {
  if (opts.yes) return true;
  if (!opts.interactive) return false;
  return /^y(es)?$/i.test((await opts.ask('Run it? [y/N] ')).trim());
}

const usage =
  'Usage: pnpm eval --client <id> [--model <id>] [--case <id>[,<id>]] [--yes] [--concurrency 4] [--grader <model> | --no-grader] [--live-catalogue] [--allow-unknown-cost]';

/** Returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        client: { type: 'string' },
        model: { type: 'string' },
        case: { type: 'string', multiple: true },
        yes: { type: 'boolean', short: 'y', default: false },
        concurrency: { type: 'string', default: '4' },
        grader: { type: 'string' },
        'no-grader': { type: 'boolean', default: false },
        'live-catalogue': { type: 'boolean', default: false },
        'allow-unknown-cost': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    deps.err(`${(error as Error).message}\n${usage}`);
    return 2;
  }
  if (args.help) {
    deps.out(usage);
    return 0;
  }
  if (!args.client) {
    deps.err(`--client is required.\n${usage}`);
    return 2;
  }
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    deps.err('--concurrency must be a positive whole number.');
    return 2;
  }

  const clientsDir = deps.clientsDir ?? join(repoRoot, 'clients');
  let base: ClientConfig;
  try {
    const path = join(clientsDir, `${args.client}.yaml`);
    base = parseClientConfig(readFileSync(path, 'utf8'), path);
  } catch (error) {
    deps.err(`Cannot load client "${args.client}": ${(error as Error).message}`);
    return 2;
  }
  const set = loadEvalSet(args.client, deps.evalsDir ?? evalsRoot);
  let cases = set.cases;
  const wanted = (args.case ?? []).flatMap((c) => c.split(',')).filter(Boolean);
  if (wanted.length) {
    const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) {
      deps.err(`Unknown case id(s): ${unknown.join(', ')}`);
      return 2;
    }
    cases = cases.filter((c) => wanted.includes(c.id));
  }

  const client = prepareClient(base, { model: args.model, setup: set.setup });
  const graderModel = args['no-grader'] ? null : (args.grader ?? DEFAULT_GRADER_MODEL);
  const estimate = estimateRunCost({ client, cases, graderModel });
  deps.out(
    [
      `Eval ${client.id} on ${client.model.id} (effort ${client.model.effort}), grader ${graderModel ?? 'off'}`,
      `${estimate.cases} cases, ${estimate.turns} customer turns, prompt prefix ~${estimate.promptTokens} tokens`,
      `Estimated cost: ${formatUsd(estimate.totalUsd)} (agent ${formatUsd(estimate.agentUsd)}, grader ${formatUsd(estimate.graderUsd)}). A rough upper estimate; billing is the source of truth.`,
    ].join('\n'),
  );

  if (estimate.totalUsd === undefined && !args['allow-unknown-cost']) {
    deps.err(
      'No price in pricing.ts for the model or the grader, so the cost cannot be shown. Check the model id, add its price, or pass --allow-unknown-cost.',
    );
    return 1;
  }

  const apiKey = deps.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    deps.err(
      'ANTHROPIC_API_KEY is not set (in the environment or the repo-root .env). Evals call the real Claude API; nothing was run.',
    );
    return 1;
  }
  if (!(await confirmRun({ yes: args.yes, interactive: deps.interactive, ask: deps.ask }))) {
    deps.err(
      deps.interactive ? 'Cancelled.' : 'Not run: pass --yes to confirm the cost (no terminal).',
    );
    return 1;
  }

  let source: CatalogueSource | undefined;
  if (args['live-catalogue']) {
    source = (deps.liveSource ?? ((c) => sourceForClient(c)))(client);
    if (!source) {
      deps.err(`Client "${client.id}" has no catalogue to sync.`);
      return 2;
    }
  } else {
    const storeUrl =
      client.catalogue?.type === 'shopify' ? client.catalogue.store_url : 'https://store.invalid';
    source = snapshotSource(storeUrl, snapshotPath(set.dir, set.setup));
  }

  const startedAt = deps.now?.() ?? new Date();
  const anthropic = deps.anthropic(apiKey);
  const results = await runCases({
    client,
    cases,
    anthropic,
    graderModel,
    source,
    concurrency,
    onCaseDone: (r, done, total) =>
      deps.out(
        `[${done}/${total}] ${r.passed ? 'pass' : 'FAIL'} ${r.id}${r.error ? ` (${r.error})` : ''}`,
      ),
  });
  const report = buildReport({
    client: client.id,
    model: client.model.id,
    graderModel,
    catalogue: args['live-catalogue'] ? 'live' : 'snapshot',
    startedAt,
    finishedAt: deps.now?.() ?? new Date(),
    cases: results,
  });

  const dir = deps.reportsDir ?? join(evalsRoot, 'reports');
  mkdirSync(dir, { recursive: true });
  const base_ = join(dir, reportBaseName(report));
  writeFileSync(`${base_}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base_}.md`, renderMarkdown(report));
  const t = report.totals;
  const cwd = deps.env.INIT_CWD ?? process.cwd();
  deps.out(
    [
      `Passed ${t.passed}/${t.cases} (${(t.passRate * 100).toFixed(0)}%). Agent cost $${t.agentCostUsd.toFixed(4)} ($${t.costPerConversationUsd.toFixed(4)} per conversation), grader $${t.graderCostUsd.toFixed(4)}. Latency p50 ${(t.latencyMs.p50 / 1000).toFixed(1)} s, p95 ${(t.latencyMs.p95 / 1000).toFixed(1)} s.`,
      `Report: ${relative(cwd, `${base_}.md`)}`,
      `        ${relative(cwd, `${base_}.json`)}`,
    ].join('\n'),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadDotEnv();
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const code = await main(process.argv.slice(2), {
    env: process.env,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    interactive: Boolean(process.stdin.isTTY),
    ask: (q) => rl!.question(q),
    anthropic: (apiKey) => new Anthropic({ apiKey }),
  }).finally(() => rl?.close());
  process.exit(code);
}
