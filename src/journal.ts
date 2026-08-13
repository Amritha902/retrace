import { DivergenceError } from "./errors.ts";

/**
 * A recorded effect, exactly as it appears in the event log.
 */
export interface JournalEntry {
  index: number;
  kind: string;
  key: string;
  value: unknown;
  /**
   * A digest of whatever the caller fed this effect, recorded beside its
   * result. The journal never looks inside it — it only hands back whether the
   * stamp it has still matches the stamp being offered, so the caller can say
   * whether a replayed value is still an answer to the question being asked.
   */
  stamp?: string;
}

export interface EffectOutcome<T> {
  /** Position this effect claimed in the run's effect sequence. */
  index: number;
  value: T;
  /** True when the value came out of the log instead of the world. */
  replayed: boolean;
  /**
   * True when this value came out of the log but was recorded against
   * different inputs than the ones offered now. Not an error — replaying the
   * steps below the one you changed is what forking *is* — but it is the
   * difference between a prefix that still answers the question and one that
   * answers an older one.
   */
  stale: boolean;
  durationMs: number;
  /**
   * Effects recorded inside this one. Populated when a replay serves an effect
   * whose owner never ran, so the caller can put them back in its own log —
   * a replay is supposed to reproduce the log, not a shorter version of it.
   */
  nested: readonly JournalEntry[];
}

export type DivergencePolicy = "strict" | "live";

/**
 * Kinds whose values are arbitrary: a timestamp, an id, a random draw. Nothing
 * downstream cares *what* they are, only that they don't change between runs.
 * They resolve by key rather than by position — see `Journal.deterministic`.
 */
export const DETERMINISTIC_KINDS = ["clock", "uuid", "random"] as const;

/** Separates an effect from the effects recorded inside it. */
const NESTED = "/";

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
  private readonly keyed: ReadonlyMap<string, unknown>;

  /**
   * `recorded` is the positional sequence: it fixes the shape of the run and a
   * mismatch in it is a divergence. `keyed` holds values that only have to be
   * stable, and stays available after the positional sequence runs out.
   */
  constructor(
    recorded: readonly JournalEntry[] = [],
    onDivergence: DivergencePolicy = "strict",
    keyed: readonly JournalEntry[] = [],
  ) {
    this.recorded = recorded;
    this.onDivergence = onDivergence;
    this.keyed = new Map(keyed.map((e) => [`${e.kind}:${e.key}`, e.value]));
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

  /**
   * `stamp` describes the inputs this effect is about to be run with. Supplying
   * it costs nothing on a fresh run and buys the one thing a log otherwise
   * cannot tell you on a replay: whether the recorded answer was given to the
   * same question.
   */
  async effect<T>(
    kind: string,
    key: string,
    execute: () => Promise<T> | T,
    stamp?: string,
  ): Promise<EffectOutcome<T>> {
    // Claimed before executing, so effects recorded *inside* this one take the
    // slots after it rather than colliding with it.
    const index = this.cursor++;
    const entry = this.recorded[index];

    if (entry !== undefined) {
      if (entry.kind === kind && entry.key === key) {
        return {
          index,
          value: entry.value as T,
          replayed: true,
          // Only comparable when both sides carry one; a log recorded before
          // stamps existed is silent about this rather than wrong about it.
          stale: entry.stamp !== undefined && stamp !== undefined && entry.stamp !== stamp,
          durationMs: 0,
          nested: this.takeNested(key),
        };
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
    return {
      index,
      value,
      replayed: false,
      stale: false,
      durationMs: Date.now() - startedAt,
      nested: [],
    };
  }

  /**
   * A value that has to survive replay but carries no meaning of its own — the
   * time, an id, a random draw.
   *
   * Unlike `effect` this resolves by key, not by position, and the key table
   * outlives the positional sequence. Two reasons. A clock read is not part of
   * the shape of a run, so a missing one is not a divergence worth failing on.
   * And a fork that has gone live past the end of the log still gets the
   * parent's timestamps and ids, which is what makes the two runs comparable:
   * the only thing that differs between them is the thing you changed.
   */
  async deterministic<T>(
    kind: (typeof DETERMINISTIC_KINDS)[number],
    key: string,
    execute: () => Promise<T> | T,
  ): Promise<EffectOutcome<T>> {
    const index = this.cursor++;
    const recorded = this.recall(kind, key);
    if (recorded !== undefined) {
      return { index, value: recorded as T, replayed: true, stale: false, durationMs: 0, nested: [] };
    }

    const startedAt = Date.now();
    const value = await execute();
    return {
      index,
      value,
      replayed: false,
      stale: false,
      durationMs: Date.now() - startedAt,
      nested: [],
    };
  }

  /**
   * The recorded value for a deterministic key, or undefined if there isn't
   * one. `deterministic` is the way in; this exists for a caller that has to
   * resolve a read *before* it can claim a slot for it — parallel tool calls,
   * which execute in one order and are journaled in another.
   */
  recall(kind: (typeof DETERMINISTIC_KINDS)[number], key: string): unknown {
    return this.keyed.get(`${kind}:${key}`);
  }

  /**
   * Consume the effects recorded inside the one just replayed. Their owner was
   * served from the log, so it never ran and never asked for them; leaving them
   * in the cursor's path would make the next real effect look like a divergence.
   */
  private takeNested(ownerKey: string): JournalEntry[] {
    const prefix = ownerKey + NESTED;
    const taken: JournalEntry[] = [];
    let entry = this.recorded[this.cursor];
    while (entry !== undefined && entry.key.startsWith(prefix)) {
      taken.push(entry);
      this.cursor++;
      entry = this.recorded[this.cursor];
    }
    return taken;
  }
}

/** Build the key under which an effect nested inside `ownerKey` is recorded. */
export function nestedKey(ownerKey: string, kind: string, ordinal: number): string {
  return `${ownerKey}${NESTED}${kind}:${ordinal}`;
}

/** What these functions need from a log's `effect` events. */
export interface RecordedEffect {
  step: number;
  index: number;
  kind: string;
  key: string;
  value: unknown;
  /** Digest of the model request this effect answered; becomes the entry's stamp. */
  requestHash?: string;
}

/** Take the effects a fork should replay: everything recorded below `atStep`. */
export function journalUpToStep(
  effects: readonly RecordedEffect[],
  atStep: number,
): JournalEntry[] {
  return effects
    .filter((e) => e.step < atStep)
    .sort((a, b) => a.index - b.index)
    .map((e, i) => entryOf(e, i));
}

/** One log event as a journal entry, renumbered to its position in the prefix. */
export function entryOf(effect: RecordedEffect, index: number): JournalEntry {
  return {
    index,
    kind: effect.kind,
    key: effect.key,
    value: effect.value,
    ...(effect.requestHash === undefined ? {} : { stamp: effect.requestHash }),
  };
}

/**
 * The clock, id and random values from a log, at every step.
 *
 * These are not cut at the fork point the way `journalUpToStep` cuts the
 * positional sequence. A fork is supposed to differ from its parent in one
 * respect; a tool that stamps `now()` in a step that runs live would otherwise
 * add a second difference nobody asked for.
 */
export function deterministicEntries(effects: readonly RecordedEffect[]): JournalEntry[] {
  const kinds = new Set<string>(DETERMINISTIC_KINDS);
  return effects
    .filter((e) => kinds.has(e.kind))
    .map((e) => ({ index: e.index, kind: e.kind, key: e.key, value: e.value }));
}
