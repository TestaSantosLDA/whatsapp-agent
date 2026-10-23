/** Cost estimate shown before an eval run starts (WA-019). Rough by design; billing is the truth. */
import type { ClientConfig } from '@wa/shared';
import { z } from 'zod';
import { estimateCost } from '../agent/pricing.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { agentTools } from '../agent/registry.js';
import { handoffToHuman } from '../agent/tools/handoff-to-human.js';
import { offerChoices } from '../agent/tools/offer-choices.js';
import type { EvalCase } from './cases.js';

/** Assumptions behind the estimate, kept generous so a run rarely costs more than shown. */
export const ESTIMATE = {
  /** Characters per token for this mix of Portuguese, English and JSON. */
  charsPerToken: 3.5,
  /** Claude requests per customer turn (tool calls mean several). */
  requestsPerTurn: 3,
  /** Uncached input per request: history, tool results, turn context. */
  freshInputPerRequest: 2000,
  /** Output (incl. thinking) per request. */
  outputPerRequest: 700,
  /** Grader input beyond the transcript (instructions, policies, rubric). */
  graderBaseInput: 3500,
  graderInputPerTurn: 600,
  graderOutput: 400,
} as const;

export interface CostEstimate {
  cases: number;
  turns: number;
  /** Tokens of the cached prefix (system prompt and tool definitions). */
  promptTokens: number;
  agentUsd: number | undefined;
  graderUsd: number | undefined;
  /** Undefined when a model has no price in pricing.ts. */
  totalUsd: number | undefined;
}

/** Tokens of the system prompt plus the tool definitions the client sends on every request. */
export function promptTokens(client: ClientConfig): number {
  const enabled = new Set(client.tools);
  const tools = [offerChoices, handoffToHuman, ...agentTools.filter((t) => enabled.has(t.name))];
  const toolText = JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.inputSchema),
    })),
  );
  return Math.ceil((buildSystemPrompt(client).length + toolText.length) / ESTIMATE.charsPerToken);
}

export function estimateRunCost(opts: {
  client: ClientConfig;
  cases: EvalCase[];
  graderModel: string | null;
}): CostEstimate {
  const { client, cases, graderModel } = opts;
  const prompt = promptTokens(client);
  const turns = cases.reduce(
    (n, c) => n + c.turns.length + (c.earlier ?? []).reduce((m, e) => m + e.turns.length, 0),
    0,
  );
  const requests = turns * ESTIMATE.requestsPerTurn;
  const agentUsd = estimateCost(client.model.id, {
    // Each conversation writes the prefix once (concurrent cases may all miss the cache).
    cacheWriteTokens: prompt * cases.length,
    cacheReadTokens: prompt * Math.max(0, requests - cases.length),
    inputTokens: requests * ESTIMATE.freshInputPerRequest,
    outputTokens: requests * ESTIMATE.outputPerRequest,
  });
  const graderUsd = graderModel
    ? estimateCost(graderModel, {
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        inputTokens: cases.length * ESTIMATE.graderBaseInput + turns * ESTIMATE.graderInputPerTurn,
        outputTokens: cases.length * ESTIMATE.graderOutput,
      })
    : 0;
  return {
    cases: cases.length,
    turns,
    promptTokens: prompt,
    agentUsd,
    graderUsd,
    totalUsd: agentUsd === undefined || graderUsd === undefined ? undefined : agentUsd + graderUsd,
  };
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return 'unknown (no price in pricing.ts)';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
