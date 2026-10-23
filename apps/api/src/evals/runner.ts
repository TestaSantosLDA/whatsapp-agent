/**
 * Plays eval cases through the real agent (WA-019): an in-memory app (PGlite) with the real
 * ClaudeResponder, every customer message posted to the simulator API, so it goes through the
 * webhook, the queue, the conversation job, the tools and the history replay exactly as in the
 * simulator UI.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ClientConfig, MetaSendMessage } from '@wa/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ClaudeResponder, type ToolCallRecord } from '../agent/claude-responder.js';
import { agentTools } from '../agent/registry.js';
import { createApp } from '../app.js';
import { ShopifyPublicSource, type CatalogueSource } from '../catalogue/source.js';
import { syncCatalogue } from '../catalogue/sync.js';
import { ClientRegistry } from '../clients/registry.js';
import { openDb, type Db } from '../db/index.js';
import { agentRuns, contacts, conversations, leads, messages, outbox } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { seedDocument, seedProductOverrides } from '../knowledge/seed.js';
import type { EvalCase, EvalSetup } from './cases.js';
import { runChecks, type CheckResult, type ToolCallSummary, type Transcript } from './checks.js';
import { gradeConversation, type Grade } from './grader.js';

export interface CaseResult {
  id: string;
  title: string;
  use_case: EvalCase['use_case'];
  language: EvalCase['language'];
  passed: boolean;
  checks: CheckResult[];
  grade?: Grade;
  /** The case could not be played or graded at all. */
  error?: string;
  transcript: Transcript;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** Agent cost of the conversation (grader excluded), USD. */
  costUsd: number;
}

export interface RunOptions {
  /** The client config as the eval uses it: see prepareClient. */
  client: ClientConfig;
  cases: EvalCase[];
  anthropic: Anthropic;
  /** Model that grades the rubrics; null skips the LLM grader. */
  graderModel: string | null;
  /** Default: the same client as the agent. */
  graderAnthropic?: Anthropic;
  source: CatalogueSource;
  /** Seeds the eval set's knowledge documents and approved product data (WA-026). */
  setup?: EvalSetup;
  concurrency?: number;
  /** Longest a single turn may take before the case is abandoned. */
  turnTimeoutMs?: number;
  onCaseDone?: (result: CaseResult, done: number, total: number) => void;
}

/**
 * The client config for an eval run: the model overridden, the eval set's extra product data
 * merged in, and the simulator channel (an eval must never reach a real WhatsApp customer).
 */
export function prepareClient(
  base: ClientConfig,
  opts: { model?: string; setup?: EvalSetup },
): ClientConfig {
  return {
    ...base,
    channel: { ...base.channel, type: 'simulator' },
    model: { ...base.model, id: opts.model ?? base.model.id },
    product_data: { ...base.product_data, ...opts.setup?.product_data },
  };
}

/** Serves a committed products.json snapshot as page 1 of a fake store. */
export function snapshotSource(storeUrl: string, file: string): CatalogueSource {
  const body = readFileSync(file, 'utf8');
  return new ShopifyPublicSource({
    storeUrl,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      const page = url.searchParams.get('page');
      return new Response(page === '1' ? body : '{"products":[]}', {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}

export function snapshotPath(dir: string, setup: EvalSetup): string {
  return join(dir, setup.catalogue ?? 'catalogue.json');
}

/** The eval set's documents and approved product data, as if uploaded and approved. */
export async function seedKnowledge(db: Db, client: ClientConfig, setup?: EvalSetup) {
  if (!setup) return;
  for (const doc of setup.documents) await seedDocument(db, client.id, doc);
  if (Object.keys(setup.product_overrides).length) {
    await seedProductOverrides(db, client, setup.product_overrides);
  }
}

/** Plays every case and returns the results in case order. */
export async function runCases(opts: RunOptions): Promise<CaseResult[]> {
  const { client } = opts;
  const handle = openDb({ pgliteDir: 'memory' });
  await handle.migrate();
  const db = handle.db;
  try {
    const synced = await syncCatalogue({ db, client, source: opts.source });
    if (!synced.ok) throw new Error(`catalogue sync failed: ${synced.error}`);
    await seedKnowledge(db, client, opts.setup);

    // One responder per customer phone, so each case has its own clock.
    const responders = new Map<string, ClaudeResponder>();
    const built = createApp({
      env: loadEnv({
        SIMULATOR_WEBHOOK_SECRET: randomUUID(),
        PUBLIC_BASE_URL: 'http://eval.local',
      }),
      db,
      clients: new ClientRegistry([client]),
      responder: {
        respond: (input) => {
          const responder = responders.get(input.contact.waId);
          if (!responder) throw new Error(`no eval responder for ${input.contact.waId}`);
          return responder.respond(input);
        },
      },
      debounceMs: 0,
    });

    const results: CaseResult[] = new Array(opts.cases.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (let i = next++; i < opts.cases.length; i = next++) {
        const evalCase = opts.cases[i]!;
        const phone = phoneFor(evalCase, i);
        responders.set(
          phone,
          new ClaudeResponder({
            db,
            anthropic: opts.anthropic,
            tools: agentTools,
            now: () => new Date(evalCase.now),
            backoffice: built.backoffice,
          }),
        );
        results[i] = await playCase({ ...opts, db, app: built.app, phone, evalCase });
        opts.onCaseDone?.(results[i]!, ++done, opts.cases.length);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, opts.cases.length)) }, () =>
        worker(),
      ),
    );
    await built.queue.drain();
    return results;
  } finally {
    await handle.close();
  }
}

function phoneFor(evalCase: EvalCase, index: number): string {
  const n = String(index + 1).padStart(6, '0');
  return evalCase.language === 'en' ? `447700${n}` : `351910${n}`;
}

type App = ReturnType<typeof createApp>['app'];

async function playCase(
  opts: RunOptions & { db: Db; app: App; phone: string; evalCase: EvalCase },
): Promise<CaseResult> {
  const { db, app, phone, evalCase, client } = opts;
  const transcript: Transcript = { turns: [], status: 'bot', leads: [], emails: [] };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let costUsd = 0;
  let conversationId: string | undefined;
  let seenOutbound = 0;
  let seenRuns = 0;
  let error: string | undefined;

  try {
    for (const turn of evalCase.turns) {
      const text = typeof turn === 'string' ? turn : 'text' in turn ? turn.text : undefined;
      let body: Record<string, unknown>;
      let customer: string;
      let turnError: string | undefined;
      if (text !== undefined) {
        body = { phone, name: evalCase.customer.name, text };
        customer = text;
      } else {
        const title = (turn as { tap: string }).tap;
        const option = conversationId ? await findOption(db, conversationId, title) : undefined;
        if (option) {
          body = { phone, name: evalCase.customer.name, reply: option };
          customer = `[tap] ${option.title}`;
        } else {
          // The agent did not offer that choice: the customer types it instead.
          body = { phone, name: evalCase.customer.name, text: title };
          customer = title;
          turnError = `tap "${title}" was not offered as a button or list option`;
        }
      }

      const started = Date.now();
      const res = await app.request(`/sim/${client.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`simulator answered ${res.status}: ${await res.text()}`);
      conversationId ??= await findConversation(db, client.id, phone);
      await waitForTurn(db, conversationId, opts.turnTimeoutMs ?? 300_000);
      const latencyMs = Date.now() - started;

      const out = await db
        .select({ payload: messages.payload })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      const replies = out.slice(seenOutbound).map((m) => renderOutbound(m.payload));
      seenOutbound = out.length;

      const runs = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.conversationId, conversationId))
        .orderBy(asc(agentRuns.createdAt));
      const turnRuns = runs.slice(seenRuns);
      seenRuns = runs.length;
      let turnCost = 0;
      for (const run of turnRuns) {
        usage.inputTokens += run.inputTokens;
        usage.outputTokens += run.outputTokens;
        usage.cacheReadTokens += run.cacheReadTokens;
        turnCost += Number(run.costUsd ?? 0);
      }
      costUsd += turnCost;
      // Retries leave an errored run before the good one; the turn failed only if all did.
      if (turnRuns.length && turnRuns.every((r) => r.error)) {
        turnError ??= `agent failed: ${turnRuns.at(-1)!.error}`;
      }
      transcript.turns.push({
        customer,
        replies,
        toolCalls: turnRuns.flatMap((r) => (r.toolCalls as ToolCallRecord[]).map(summariseCall)),
        latencyMs: turnRuns.length ? latencyMs : 0,
        costUsd: turnCost,
        error: turnError,
      });
    }

    if (conversationId) {
      const [conv] = await db
        .select({ status: conversations.status })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      transcript.status = conv?.status ?? 'bot';
      transcript.leads = await db
        .select({ type: leads.type, branchId: leads.branchId })
        .from(leads)
        .where(eq(leads.conversationId, conversationId))
        .orderBy(asc(leads.createdAt));
      transcript.emails = await db
        .select({ kind: outbox.kind, to: outbox.to })
        .from(outbox)
        .where(eq(outbox.conversationId, conversationId))
        .orderBy(asc(outbox.createdAt));
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const checks = error ? [] : runChecks(evalCase.checks, transcript);
  let grade: Grade | undefined;
  if (!error && opts.graderModel) {
    try {
      grade = await gradeConversation({
        anthropic: opts.graderAnthropic ?? opts.anthropic,
        model: opts.graderModel,
        client,
        evalCase,
        transcript,
      });
    } catch (e) {
      error = `grader failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return {
    id: evalCase.id,
    title: evalCase.title,
    use_case: evalCase.use_case,
    language: evalCase.language,
    passed: !error && checks.every((c) => c.pass) && (grade?.pass ?? true),
    checks,
    grade,
    error,
    transcript,
    usage,
    costUsd,
  };
}

async function findConversation(db: Db, clientId: string, phone: string): Promise<string> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(contacts.clientId, clientId), eq(contacts.waId, phone)))
    .orderBy(asc(conversations.createdAt))
    .limit(1);
  if (!row) throw new Error(`no conversation for ${phone}`);
  return row.id;
}

/** The job marks the customer's messages processed after replying (or after failing for good). */
async function waitForTurn(db: Db, conversationId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          isNull(messages.processedAt),
        ),
      );
    if (!row?.n) return;
    if (Date.now() > deadline) throw new Error(`turn timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The button or list row with this title (ignoring case) in the latest interactive message. */
async function findOption(db: Db, conversationId: string, title: string) {
  const rows = await db
    .select({ payload: messages.payload })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.type, 'interactive'),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const last = rows.at(-1)?.payload as MetaSendMessage | undefined;
  if (last?.type !== 'interactive') return undefined;
  const want = title.trim().toLowerCase();
  const action = last.interactive.action;
  if (last.interactive.type === 'button' && 'buttons' in action) {
    const b = action.buttons.find((x) => x.reply.title.toLowerCase() === want);
    return b ? { type: 'button_reply' as const, id: b.reply.id, title: b.reply.title } : undefined;
  }
  if ('sections' in action) {
    const row = action.sections.flatMap((s) => s.rows).find((r) => r.title.toLowerCase() === want);
    return row ? { type: 'list_reply' as const, id: row.id, title: row.title } : undefined;
  }
  return undefined;
}

/** A plain-text view of an outbound message, with its options and captions. */
export function renderOutbound(payload: unknown): string {
  const p = payload as MetaSendMessage;
  switch (p.type) {
    case 'text':
      return p.text.body;
    case 'image':
      return `[image] ${p.image.caption ?? ''}`.trim();
    case 'document':
      return `[document ${p.document.filename ?? ''}] ${p.document.caption ?? ''}`.trim();
    case 'interactive': {
      const action = p.interactive.action;
      if ('buttons' in action) {
        return `${p.interactive.body.text}\n[buttons: ${action.buttons.map((b) => b.reply.title).join(' | ')}]`;
      }
      const rows = action.sections.flatMap((s) => s.rows).map((r) => r.title);
      return `${p.interactive.body.text}\n[list "${action.button}": ${rows.join(' | ')}]`;
    }
  }
}

function summariseCall(call: ToolCallRecord): ToolCallSummary {
  const input = JSON.stringify(call.input);
  return {
    name: call.name,
    ok: call.ok,
    input: input && input.length > 300 ? `${input.slice(0, 299)}…` : input,
    error: call.error,
  };
}
