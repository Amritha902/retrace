import type { Usage } from "./types.ts";

/** USD per million tokens, list price. */
export interface RateCard {
  input: number;
  output: number;
}

/**
 * Rate cards are data, not policy — override them with `setRate` when your org
 * has different pricing, or when a model ships that this table doesn't know.
 */
const RATES = new Map<string, RateCard>([
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-mythos-5", { input: 10, output: 50 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-sonnet-5", { input: 3, output: 15 }],
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
]);

/** Cache reads bill at a tenth of input; 5-minute cache writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function setRate(model: string, rate: RateCard): void {
  RATES.set(model, rate);
}

export function getRate(model: string): RateCard | undefined {
  return RATES.get(model);
}

/**
 * Price a single model response. Unknown models price at zero rather than
 * guessing — a wrong number in a budget check is worse than an obvious zero.
 */
export function priceUsage(model: string, usage: Usage): number {
  const rate = RATES.get(model);
  if (!rate) return 0;
  const perToken = rate.input / 1_000_000;
  const perOutputToken = rate.output / 1_000_000;
  return (
    usage.inputTokens * perToken +
    usage.cacheReadTokens * perToken * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken * CACHE_WRITE_MULTIPLIER +
    usage.outputTokens * perOutputToken
  );
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}
