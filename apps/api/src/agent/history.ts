import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessageRow } from '../services/messages.js';

/** The tool calls of one earlier turn, as recorded in agent_runs. */
export interface TurnLog {
  createdAt: Date;
  toolCalls: { name: string; input: unknown; ok: boolean; output?: string; error?: string }[];
}

/**
 * Rebuilds the conversation for Claude from stored messages: customer messages become user
 * turns and our sends become assistant turns, consecutive ones merged.
 *
 * Each earlier reply is preceded by a system message listing the tools Claude used for it and
 * what they returned, so variant ids, prices and quantities from earlier turns stay known (a
 * customer confirms a cart one turn after seeing it). Thinking blocks are not replayed.
 *
 * The rebuild is deterministic and only ever appends, so the prompt cache keeps hitting from one
 * turn to the next.
 */
export function toClaudeMessages(rows: MessageRow[], logs: TurnLog[] = []): BetaMessageParam[] {
  type Item = { at: number; row?: MessageRow; log?: TurnLog };
  const items: Item[] = [
    ...rows.map((row) => ({ at: row.createdAt?.getTime() ?? 0, row })),
    ...logs.map((log) => ({ at: log.createdAt.getTime(), log })),
  ];
  // Messages keep their order; on a tie, a log sorts after the customer's message and before
  // the replies it led to.
  const rank = (i: Item) => (i.log ? 1 : i.row!.direction === 'inbound' ? 0 : 2);
  items.sort((a, b) => a.at - b.at || (a.log || b.log ? rank(a) - rank(b) : 0));

  const out: BetaMessageParam[] = [];
  let pendingLog: string | undefined;
  for (const item of items) {
    if (item.log) {
      const text = describeLog(item.log);
      if (text) pendingLog = pendingLog ? `${pendingLog}\n${text}` : text;
      continue;
    }
    const row = item.row!;
    const role = row.direction === 'inbound' ? 'user' : 'assistant';
    const last = out.at(-1);
    if (role === 'user') pendingLog = undefined;
    if (role === 'assistant' && pendingLog && last?.role === 'user') {
      out.push({ role: 'system', content: pendingLog });
    }
    pendingLog = role === 'assistant' ? undefined : pendingLog;

    const text = textFor(row);
    const prev = out.at(-1);
    if (prev?.role === role && Array.isArray(prev.content)) {
      prev.content.push({ type: 'text', text });
    } else {
      out.push({ role, content: [{ type: 'text', text }] });
    }
  }
  // The API needs the conversation to start with the customer.
  while (out[0] && out[0].role !== 'user') out.shift();
  return out;
}

function textFor(row: MessageRow): string {
  const text = (row.text ?? '').trim() || `[${row.type}]`;
  if (row.direction !== 'inbound') return text;
  // A tapped button or list row: its id says what was picked (e.g. product:<variant_id>);
  // the title alone is cut to 20-24 characters and can be the same for several variants.
  const interactive = (row.payload as { interactive?: Record<string, { id?: string }> })
    ?.interactive;
  const id = interactive?.list_reply?.id ?? interactive?.button_reply?.id;
  return id ? `${text} [tapped: ${id}]` : text;
}

function describeLog(log: TurnLog): string {
  if (!log.toolCalls.length) return '';
  const lines = log.toolCalls.map(
    (c) =>
      `- ${c.name} ${JSON.stringify(c.input)} → ${c.ok ? (c.output ?? 'ok') : `error: ${c.error}`}`,
  );
  return `Tools used for the next reply (the customer did not see this):\n${lines.join('\n')}`;
}
