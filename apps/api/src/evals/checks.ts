/** Deterministic checks of a played conversation against its eval case (WA-019). */
import { matches, parseRegexLiteral, type EvalChecks } from './cases.js';

export interface ToolCallSummary {
  name: string;
  ok: boolean;
  /** Short JSON of the input, for the report and the grader. */
  input?: string;
  error?: string;
}

export interface TurnTranscript {
  /** What the customer sent: text, or "[tap] Title". */
  customer: string;
  /** The agent's messages for this turn, as plain text (options and captions included). */
  replies: string[];
  toolCalls: ToolCallSummary[];
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface Transcript {
  turns: TurnTranscript[];
  status: string;
  leads: { type: string; branchId: string | null }[];
  emails: { kind: string; to: string[] }[];
}

export interface CheckResult {
  /** e.g. `tools_called: save_lead`, `must_include: /249,00/`. */
  name: string;
  pass: boolean;
  detail?: string;
}

/** Runs every deterministic check the case lists. Order follows the checks schema. */
export function runChecks(checks: EvalChecks, t: Transcript): CheckResult[] {
  const results: CheckResult[] = [];
  const called = new Set(t.turns.flatMap((turn) => turn.toolCalls.map((c) => c.name)));
  const replies = t.turns.flatMap((turn) => turn.replies).join('\n\n');

  for (const tool of checks.tools_called) {
    results.push({
      name: `tools_called: ${tool}`,
      pass: called.has(tool),
      detail: called.has(tool) ? undefined : `called: ${[...called].join(', ') || 'none'}`,
    });
  }
  for (const tool of checks.tools_not_called) {
    results.push({ name: `tools_not_called: ${tool}`, pass: !called.has(tool) });
  }
  for (const pattern of checks.must_include) {
    results.push({ name: `must_include: ${pattern}`, pass: matches(pattern, replies) });
  }
  for (const pattern of checks.must_not_include) {
    const found = matches(pattern, replies);
    results.push({
      name: `must_not_include: ${pattern}`,
      pass: !found,
      detail: found ? excerpt(pattern, replies) : undefined,
    });
  }
  if (checks.lead === 'none') {
    const other = t.leads.filter((l) => l.type !== 'handoff');
    results.push({
      name: 'lead: none',
      pass: other.length === 0,
      detail: other.length ? `stored: ${describeLeads(other)}` : undefined,
    });
  } else if (checks.lead) {
    const want = checks.lead;
    const ok = t.leads.some(
      (l) => (!want.type || l.type === want.type) && (!want.branch || l.branchId === want.branch),
    );
    results.push({
      name: `lead: ${[want.type, want.branch && `@${want.branch}`].filter(Boolean).join(' ')}`,
      pass: ok,
      detail: ok ? undefined : `stored: ${describeLeads(t.leads) || 'none'}`,
    });
  }
  if (checks.status) {
    results.push({
      name: `status: ${checks.status}`,
      pass: t.status === checks.status,
      detail: t.status === checks.status ? undefined : `was ${t.status}`,
    });
  }
  for (const kind of checks.emails) {
    const ok = t.emails.some((e) => e.kind === kind);
    results.push({
      name: `emails: ${kind}`,
      pass: ok,
      detail: ok ? undefined : `outbox: ${t.emails.map((e) => e.kind).join(', ') || 'empty'}`,
    });
  }
  for (const n of checks.silent_turns) {
    const turn = t.turns[n - 1];
    const ok = turn !== undefined && turn.replies.length === 0;
    results.push({
      name: `silent_turns: ${n}`,
      pass: ok,
      detail: ok ? undefined : turn ? `replied: ${turn.replies.join(' | ')}` : 'no such turn',
    });
  }
  // A turn that failed (the job's failure handler apologised) is always a failure.
  t.turns.forEach((turn, i) => {
    if (turn.error) results.push({ name: `turn ${i + 1} error`, pass: false, detail: turn.error });
  });
  return results;
}

function describeLeads(leads: Transcript['leads']): string {
  return leads.map((l) => `${l.type}@${l.branchId ?? '?'}`).join(', ');
}

/** A short piece of text around the first match, so a report shows why a check failed. */
function excerpt(pattern: string, text: string): string {
  const re = parseRegexLiteral(pattern);
  const at = re ? text.search(re) : text.toLowerCase().indexOf(pattern.toLowerCase());
  if (at < 0) return '';
  return `…${text.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, ' ')}…`;
}
