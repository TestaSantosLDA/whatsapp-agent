/** LLM grader (WA-019): judges one played conversation against its rubric, pass or fail. */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ClientConfig } from '@wa/shared';
import { z } from 'zod';
import { estimateCost } from '../agent/pricing.js';
import type { EvalCase } from './cases.js';
import type { Transcript } from './checks.js';

export const DEFAULT_GRADER_MODEL = 'claude-opus-5-5';

const gradeSchema = z.object({
  reason: z
    .string()
    .describe('One to three sentences: what the agent did well or badly against the rubric.'),
  pass: z.boolean().describe('true only if the conversation meets every point of the rubric.'),
});

export interface Grade {
  pass: boolean;
  reason: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Turns a transcript into the plain text the grader reads. */
export function renderTranscript(t: Transcript): string {
  const lines: string[] = [];
  t.turns.forEach((turn, i) => {
    lines.push(`--- Turn ${i + 1}`);
    lines.push(`CUSTOMER: ${turn.customer}`);
    for (const call of turn.toolCalls) {
      lines.push(
        `  (tool ${call.name}${call.ok ? '' : ' FAILED'}${call.input ? ` ${call.input}` : ''}${call.error ? ` → ${call.error}` : ''})`,
      );
    }
    if (turn.error) lines.push(`  (turn failed: ${turn.error})`);
    if (turn.replies.length === 0) lines.push('AGENT: (no reply)');
    for (const reply of turn.replies) lines.push(`AGENT: ${reply}`);
  });
  lines.push('--- End');
  lines.push(`Conversation status: ${t.status} (human = handed to a colleague)`);
  lines.push(
    `Leads stored: ${t.leads.map((l) => `${l.type} → ${l.branchId ?? '?'}`).join(', ') || 'none'}`,
  );
  lines.push(`Emails to the company: ${t.emails.map((e) => e.kind).join(', ') || 'none'}`);
  return lines.join('\n');
}

function graderSystem(client: ClientConfig): string {
  const policies = Object.entries(client.policies)
    .map(([key, text]) => `### ${key}\n${text.trim()}`)
    .join('\n\n');
  return `You grade conversations of ${client.name}'s WhatsApp sales assistant for an evaluation set. You get one scripted conversation, the facts the assistant had available, and a rubric. Decide whether the assistant's behaviour meets the rubric.

How to judge:
- Judge only what the rubric asks, plus these always-on rules: replies are in the customer's language (Portuguese must be European Portuguese, never Brazilian), short enough for WhatsApp, polite, and never invent prices, stock, dates, discounts or policies.
- Product facts come from the tool calls shown in the transcript; company facts from the policies below. A fact the assistant states that is in neither is invented.
- Small wording differences are fine. Do not fail a case for style preferences the rubric does not mention.
- Separate code already checked which tools were called and which words appear; do not re-check those mechanically.
- Be strict about the substance: if any rubric point is clearly not met, the case fails.

# Policies the assistant had
${policies || '(none)'}`;
}

export async function gradeConversation(opts: {
  anthropic: Anthropic;
  model: string;
  client: ClientConfig;
  evalCase: EvalCase;
  transcript: Transcript;
}): Promise<Grade> {
  const { anthropic, model, client, evalCase, transcript } = opts;
  const message = await anthropic.messages.parse({
    model,
    max_tokens: 2000,
    system: graderSystem(client),
    messages: [
      {
        role: 'user',
        content: `# Case\n${evalCase.title} (use case: ${evalCase.use_case}, customer language: ${evalCase.language}, local time: ${evalCase.now})\n\n# Rubric\n${evalCase.rubric.trim()}\n\n# Conversation\n${renderTranscript(transcript)}`,
      },
    ],
    output_config: { format: zodOutputFormat(gradeSchema) },
  });
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  const costUsd = estimateCost(model, usage) ?? 0;
  const parsed = message.parsed_output;
  if (!parsed) {
    return {
      pass: false,
      reason: `grader gave no verdict (stop_reason ${message.stop_reason})`,
      model,
      costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  return {
    ...parsed,
    model,
    costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
