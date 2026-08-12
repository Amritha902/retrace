import { DivergenceError } from "./errors.ts";

/**
 * A recorded effect, exactly as it appears in the event log.
 */
export interface JournalEntry {
  index: number;
  kind: string;
  key: string;
  value: unknown;
}

export interface EffectOutcome<T> {
  value: T;
  /** True when the value came out of the log instead of the world. */
  replayed: boolean;
  durationMs: number;
}

export type DivergencePolicy = "strict" | "live";

/**
 * The single boundary between the agent loop and everything nondeterministic.
 *
 * Every model call, tool call, timestamp and id goes through `effect`. In a
 * fresh run the journal is empty, so every effect executes and is appended. In
 * a fork the journal is preloaded with the parent's effects, so the first N
 * effects come back out of the log for free and execution goes live the moment
 * the log runs out. Replay is not a separate code path — it is the same loop
 * with a non-empty journal, which is why a replayed run can't drift from a
 * recorded one.
 */
export class Journal {
  private cursor = 0;
  private readonly recorded: readonly JournalEntry[];
  private readonly onDivergence: DivergencePolicy;

  constructor(recorded: readonly JournalEntry[] = [], onDivergence: DivergencePolicy = "strict") {
    this.recorded = recorded;
    this.onDivergence = onDivergence;
  }

  /** Effects still available to replay before this journal goes live. */
  get remaining(): number {
    return Math.max(0, this.recorded.length - this.cursor);
  }

  get isReplaying(): boolean {
    return this.remaining > 0;
  }

  /** How many effects have been consumed or produced so far. */
  get index(): number {
    return this.cursor;
  }

  async effect<T>(kind: string, key: string, execute: () => Promise<T> | T): Promise<EffectOutcome<T>> {
    const index = this.cursor;
    const entry = this.recorded[index];

    if (entry !== undefined) {
      if (entry.kind === kind && entry.key === key) {
        this.cursor += 1;
        return { value: entry.value as T, replayed: true, durationMs: 0 };
      }
      if (this.onDivergence === "strict") {
        throw new DivergenceError(index, `${entry.kind}:${entry.key}`, `${kind}:${key}`);
      }
      // "live": the fork changed shape. Abandon the rest of the log and
      // execute from here — the log below this point describes a run that no
      // longer exists, so replaying any of it would be a lie.
      this.cursor = this.recorded.length;
    }

    const startedAt = Date.now();
    const value = await execute();
    this.cursor += 1;
    return { value, replayed: false, durationMs: Date.now() - startedAt };
  }
}

/** Take the effects a fork should replay: everything recorded below `atStep`. */
export function journalUpToStep(
  effects: readonly { step: number; index: number; kind: string; key: string; value: unknown }[],
  atStep: number,
): JournalEntry[] {
  return effects
    .filter((e) => e.step < atStep)
    .sort((a, b) => a.index - b.index)
    .map((e, i) => ({ index: i, kind: e.kind, key: e.key, value: e.value }));
}
