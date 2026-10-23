/** Eval cases (WA-019): the YAML schema, the per-client setup file and the loaders. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const evalsRoot = join(repoRoot, 'evals');

/** The six MVP use cases (docs/architecture.md), plus guardrails for the tricky, adversarial ones. */
export const useCases = [
  'product_advisor',
  'calculator',
  'faq',
  'lead',
  'handoff',
  'treehouse',
  'guardrails',
  /** WA-027: a returning customer served from their profile. */
  'profile',
] as const;
export type UseCase = (typeof useCases)[number];

const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/s;

/** A substring (case-insensitive) or a `/regex/flags` literal (always case-insensitive). */
const patternSchema = z
  .string()
  .min(1)
  .refine((p) => !REGEX_LITERAL.test(p) || parseRegexLiteral(p) !== null, 'invalid /regex/');

const turnSchema = z.union([
  z.string().min(1).max(4096),
  z.object({ text: z.string().min(1).max(4096) }).strict(),
  /** Taps the button or list row with this title in the agent's latest interactive message. */
  z.object({ tap: z.string().min(1).max(24) }).strict(),
]);
export type EvalTurn = z.infer<typeof turnSchema>;

export const checksSchema = z
  .object({
    /** Each of these tools is called at least once during the conversation (ok or not). */
    tools_called: z.array(z.string()).default([]),
    /** None of these tools is called. */
    tools_not_called: z.array(z.string()).default([]),
    /** Every pattern appears in the agent's replies (all turns, captions and options included). */
    must_include: z.array(patternSchema).default([]),
    /** No pattern appears in the agent's replies. */
    must_not_include: z.array(patternSchema).default([]),
    /** A lead of this type (and branch) is stored, or `none`: no lead other than a handoff. */
    lead: z
      .union([
        z.literal('none'),
        z
          .object({ type: z.string().optional(), branch: z.string().optional() })
          .strict()
          .refine((l) => l.type || l.branch, 'give type and/or branch'),
      ])
      .optional(),
    /** The conversation's status at the end. */
    status: z.enum(['bot', 'human']).optional(),
    /** Kinds of business emails that must be in the outbox (lead, handoff, order_draft). */
    emails: z.array(z.string()).default([]),
    /** 1-based turns that must get no reply (the bot is silent after a handoff). */
    silent_turns: z.array(z.number().int().positive()).default([]),
    /** WA-027: these profile fields hold a value at the end (noted by the agent). */
    profile: z.array(z.string()).optional(),
    /**
     * WA-027: the agent's replies in the main conversation are shorter on average than in the
     * `earlier` conversations (the profile said "short answers").
     */
    shorter_than_earlier: z.boolean().optional(),
  })
  .strict();
export type EvalChecks = z.infer<typeof checksSchema>;

export const evalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes'),
    title: z.string().min(1),
    use_case: z.enum(useCases),
    language: z.enum(['pt-PT', 'en']),
    /** The turn's clock (ISO with offset), so opening hours are deterministic. */
    now: z.iso.datetime({ offset: true }),
    customer: z
      .object({ name: z.string().min(1).max(60).default('Ana Costa') })
      .strict()
      .default({ name: 'Ana Costa' }),
    /**
     * WA-027: conversations the same customer had before, played first, each closed afterwards,
     * so `turns` start a new conversation with whatever the agent learnt (profile, last orders).
     */
    earlier: z
      .array(
        z
          .object({
            now: z.iso.datetime({ offset: true }),
            turns: z.array(turnSchema).min(1).max(8),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    turns: z.array(turnSchema).min(1).max(12),
    checks: checksSchema.default(checksSchema.parse({})),
    /** What the LLM grader judges: tone, helpfulness and the facts that need judgement. */
    rubric: z.string().min(20),
  })
  .strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

const caseFileSchema = z.array(evalCaseSchema).min(1);

/** Per-client eval setup (`evals/<client>/setup.json`): the catalogue snapshot and extra data. */
export const setupSchema = z
  .object({
    notes: z.string().optional(),
    /** Shopify products.json snapshot, relative to the client's eval folder. */
    catalogue: z.string().optional(),
    /** Merged over the client's `product_data` for the eval only. */
    product_data: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    /** Approved product data as the dashboard stores it (WA-026): wins over product_data. */
    product_overrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    /** Live knowledge documents for search_documents (WA-026), as passages: no file, no Claude. */
    documents: z
      .array(
        z
          .object({
            name: z.string().min(1),
            passages: z
              .array(
                z
                  .object({
                    page: z.number().int().positive().optional(),
                    label: z.string().optional(),
                    text: z.string().min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type EvalSetup = z.infer<typeof setupSchema>;

export interface EvalSet {
  clientId: string;
  dir: string;
  setup: EvalSetup;
  cases: EvalCase[];
}

/** Loads and validates every `*.yaml` case file of a client. Throws with file and path on errors. */
export function loadEvalSet(clientId: string, root = evalsRoot): EvalSet {
  const dir = join(root, clientId);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  if (files.length === 0) throw new Error(`No eval case files in ${dir}`);
  const cases = files.flatMap((f) => parseCaseFile(readFileSync(join(dir, f), 'utf8'), f));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`Duplicate eval case id "${c.id}"`);
    seen.add(c.id);
  }
  let setup: EvalSetup = { product_data: {}, product_overrides: {}, documents: [] };
  try {
    setup = setupSchema.parse(JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { clientId, dir, setup, cases };
}

export function parseCaseFile(text: string, source: string): EvalCase[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new Error(`Invalid eval case file ${source}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = caseFileSchema.safeParse(doc);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid eval case file ${source}:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** `/abc/i` → RegExp (always with the i flag); anything else → null. */
export function parseRegexLiteral(pattern: string): RegExp | null {
  const m = REGEX_LITERAL.exec(pattern);
  if (!m) return null;
  const flags = m[2]!.includes('i') ? m[2]! : `${m[2]}i`;
  try {
    return new RegExp(m[1]!, flags.replace('g', ''));
  } catch {
    return null;
  }
}

/** Whether `pattern` (substring or /regex/) occurs in `text`, ignoring case. */
export function matches(pattern: string, text: string): boolean {
  const re = parseRegexLiteral(pattern);
  return re ? re.test(text) : text.toLowerCase().includes(pattern.toLowerCase());
}
