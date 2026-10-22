/** USD per million tokens. Used for the cost estimate in agent_runs; billing is the source of truth. */
const prices: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimated cost in USD, or undefined for a model without a price here. 5-minute cache writes cost 1.25x input. */
export function estimateCost(model: string, usage: Usage): number | undefined {
  const p = prices[model];
  if (!p) return undefined;
  return (
    (usage.inputTokens * p.input +
      usage.cacheWriteTokens * p.input * 1.25 +
      usage.cacheReadTokens * p.cacheRead +
      usage.outputTokens * p.output) /
    1_000_000
  );
}
