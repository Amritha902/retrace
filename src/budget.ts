import { BudgetExceededError } from "./errors.ts";
import { priceUsage } from "./pricing.ts";
import { ZERO_USAGE, type BudgetSpec, type Totals, type Usage } from "./types.ts";

/**
 * Enforcement lives here rather than in the loop so that "the run stopped
 * because it ran out of money" is a first-class terminal state, not a crash
 * somewhere in the middle of a tool call.
 *
 * Two numbers are tracked for every charge: `costUsd`, what the tokens are
 * worth at list price, and `billedUsd`, what was actually spent. A replayed
 * step has a real cost and a zero bill, and the gap between them is the point
 * of the whole runtime.
 */
export class Budget {
  private usage: Usage = { ...ZERO_USAGE };
  private costUsd = 0;
  private billedUsd = 0;
  private steps = 0;
  private toolCalls = 0;
  private readonly startedAt: number;
  private readonly spec: BudgetSpec;

  constructor(spec: BudgetSpec = {}, now: number = Date.now()) {
    this.spec = spec;
    this.startedAt = now;
  }

  /** Called before each step. Throws if the run has already hit a limit. */
  checkStep(now: number = Date.now()): void {
    if (this.spec.steps !== undefined && this.steps >= this.spec.steps) {
      throw new BudgetExceededError("steps", this.spec.steps, this.steps + 1, this.totals(now));
    }
    this.checkWallClock(now);
    this.checkSpend(now);
  }

  checkToolCall(now: number = Date.now()): void {
    if (this.spec.toolCalls !== undefined && this.toolCalls >= this.spec.toolCalls) {
      throw new BudgetExceededError(
        "toolCalls",
        this.spec.toolCalls,
        this.toolCalls + 1,
        this.totals(now),
      );
    }
    this.checkWallClock(now);
  }

  private checkWallClock(now: number): void {
    if (this.spec.wallClockMs === undefined) return;
    const elapsed = now - this.startedAt;
    if (elapsed >= this.spec.wallClockMs) {
      throw new BudgetExceededError("wallClockMs", this.spec.wallClockMs, elapsed, this.totals(now));
    }
  }

  private checkSpend(now: number): void {
    if (this.spec.usd !== undefined && this.costUsd >= this.spec.usd) {
      throw new BudgetExceededError("usd", this.spec.usd, this.costUsd, this.totals(now));
    }
    if (this.spec.inputTokens !== undefined && this.usage.inputTokens >= this.spec.inputTokens) {
      throw new BudgetExceededError(
        "inputTokens",
        this.spec.inputTokens,
        this.usage.inputTokens,
        this.totals(now),
      );
    }
    if (this.spec.outputTokens !== undefined && this.usage.outputTokens >= this.spec.outputTokens) {
      throw new BudgetExceededError(
        "outputTokens",
        this.spec.outputTokens,
        this.usage.outputTokens,
        this.totals(now),
      );
    }
  }

  /** Record a model response. `replayed` responses cost money on paper but not in fact. */
  charge(model: string, usage: Usage, replayed: boolean): { costUsd: number; billedUsd: number } {
    const costUsd = priceUsage(model, usage);
    const billedUsd = replayed ? 0 : costUsd;
    this.usage = {
      inputTokens: this.usage.inputTokens + usage.inputTokens,
      outputTokens: this.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + usage.cacheWriteTokens,
    };
    this.costUsd += costUsd;
    this.billedUsd += billedUsd;
    return { costUsd, billedUsd };
  }

  countStep(): void {
    this.steps += 1;
  }

  countToolCall(): void {
    this.toolCalls += 1;
  }

  totals(now: number = Date.now()): Totals {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      usage: { ...this.usage },
      costUsd: this.costUsd,
      billedUsd: this.billedUsd,
      savedUsd: this.costUsd - this.billedUsd,
      wallClockMs: now - this.startedAt,
    };
  }
}
