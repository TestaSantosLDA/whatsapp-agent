import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessageRow } from '../services/messages.js';

/**
 * Rebuilds the conversation for Claude from stored messages: customer messages become user
 * turns and our sends become assistant turns, consecutive ones merged.
 *
 * Earlier turns are replayed as text only (no tool calls, no thinking blocks). The rebuild is
 * deterministic and only ever appends, so the prompt cache keeps hitting from one turn to the
 * next.
 */
export function toClaudeMessages(rows: MessageRow[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const row of rows) {
    const role = row.direction === 'inbound' ? 'user' : 'assistant';
    const text = (row.text ?? '').trim() || `[${row.type}]`;
    const last = out.at(-1);
    if (last?.role === role && Array.isArray(last.content)) {
      last.content.push({ type: 'text', text });
    } else {
      out.push({ role, content: [{ type: 'text', text }] });
    }
  }
  // The API needs the conversation to start with the customer.
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}
