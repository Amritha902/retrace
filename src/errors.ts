import type { BudgetSpec, Totals } from "./types.ts";

export class RetraceError extends Error {}

export class BudgetExceededError extends RetraceError {
  readonly limit: keyof BudgetSpec;
  readonly allowed: number;
  readonly attempted: number;
  readonly totals: Totals;

  constructor(limit: keyof BudgetSpec, allowed: number, attempted: number, totals: Totals) {
    super(`budget exceeded: ${limit} limit is ${allowed}, this step would reach ${round(attempted)}`);
    this.name = "BudgetExceededError";
    this.limit = limit;
    this.allowed = allowed;
    this.attempted = attempted;
    this.totals = totals;
  }
}

/**
 * Thrown when a replaying run asks for an effect the parent log doesn't have in
 * that slot — the fork changed the shape of the run before the fork point.
 */
export class DivergenceError extends RetraceError {
  readonly index: number;
  readonly expected: string;
  readonly actual: string;

  constructor(index: number, expected: string, actual: string) {
    super(
      `run diverged from its parent at effect ${index}: log has "${expected}", this run asked for "${actual}". ` +
        `Fork at or before the step where they still agree, or pass onDivergence: "live".`,
    );
    this.name = "DivergenceError";
    this.index = index;
    this.expected = expected;
    this.actual = actual;
  }
}

export class ToolNotFoundError extends RetraceError {
  readonly toolName: string;

  constructor(toolName: string, available: string[]) {
    super(
      `the model called "${toolName}", which is not registered. Registered tools: ${available.join(", ") || "(none)"}`,
    );
    this.name = "ToolNotFoundError";
    this.toolName = toolName;
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
