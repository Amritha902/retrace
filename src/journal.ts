import { realNow, type AmbientSource } from "./ambient.ts";
import { DivergenceError, ReplayedFailure } from "./errors.ts";
import type { RecordedFailure } from "./types.ts";

/**
 * A digest of whatever a caller fed an effect, recorded beside its result.
 *
 * The journal never interprets one — it only reports whether the stamp it has
 * still matches the stamp being offered, so the caller can say whether a
 * replayed value is still an answer to the question being asked. `facets` is
 * that same digest taken one component at a time: the journal compares them as
 * opaque strings and hands back the names of the ones that moved, leaving the
 * caller, which knows what the names mean, to say it in words.
 */
export interface Stamp {
  hash: string;
  facets?: Readonly<Record<string, string>>;
}

/**
 * A recorded effect, exactly as it appears in the event log.
 */
export interface JournalEntry {
  index: number;
  kind: string;
  key: string;
  value: unknown;
  /** Set when what was recorded here is a throw rather than a value. */
  failed?: RecordedFailure;
  stamp?: Stamp;
  /** Set when this value was substituted for the recorded one. See `applyOverrides`. */
  overridden?: true;
  /** What the recorded call read outside the journal, if anything. */
  ambient?: readonly AmbientSource[];
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
  /**
   * Which components of the stamp moved, when both stamps carry them. This is
   * the difference between "the prompt you rewrote" and "the tools you did not
   * mean to change", and it is empty rather than wrong when the recorded stamp
   * predates facets.
   */
  staleFacets: readonly string[];
  /**
   * True when this value came out of the log having been substituted for the
   * one recorded there — the caller asked "what if this had been different".
   */
  overridden: boolean;
  /**
   * What the recorded call read outside the journal. Only ever populated on a
   * replayed effect: a live one's reads are watched by the caller running the
   * body, not by the journal serving it.
   */
  ambient: readonly AmbientSource[];
  durationMs: number;
  /**
   * Effects recorded inside this one. Populated when a replay serves an effect
   * whose owner never ran, so the caller can put them back in its own log —
   * a replay is supposed to reproduce the log, not a shorter version of it.
   */
  nested: readonly JournalEntry[];
  /**
   * Set when the effect threw instead of returning, and `value` means nothing.
   *
   * The journal does not raise it, because a failure has to reach the log
   * before it reaches the caller — an effect that threw its way past `emit`
   * would leave the run's own log unable to reproduce the run. So the caller
   * records this and then raises `thrown`.
   */
  failed?: RecordedFailure;
  /**
   * What to raise once `failed` has been recorded: the original error when the
   * effect just threw, and a `ReplayedFailure` carrying the recorded message
   * when the log is the one saying it did.
   */
  thrown?: unknown;
}

export type DivergencePolicy = "strict" | "live";

/**
 * Kinds that resolve by key rather than by position — see
 * `Journal.deterministic`.
 *
 * Three of them are values nothing downstream cares about: a timestamp, an id,
 * a random draw, which only have to not change between runs. `fetch` is the odd
 * one, because a response very much has a meaning — but it belongs here for the
 * same reason: it is a read a tool made rather than a step the loop took, so it
 * is not part of the shape of the run, and a fork that goes live past the end of
 * the log should still see the world its parent saw. What keeps it honest is
 * that its key carries a digest of the request, so a call asking something else
 * finds no entry rather than the wrong one.
 */
export const DETERMINISTIC_KINDS = ["clock", "uuid", "random", "fetch"] as const;

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
  private readonly keyed: ReadonlyMap<string, JournalEntry>;

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
    this.keyed = new Map(keyed.map((e) => [`${e.kind}:${e.key}`, e]));
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
    stamp?: Stamp,
  ): Promise<EffectOutcome<T>> {
    // Claimed before executing, so effects recorded *inside* this one take the
    // slots after it rather than colliding with it.
    const index = this.cursor++;
    const entry = this.recorded[index];

    if (entry !== undefined) {
      if (entry.kind === kind && entry.key === key) {
        // Only comparable when both sides carry a stamp; a log recorded before
        // stamps existed is silent about this rather than wrong about it.
        const stale =
          entry.stamp !== undefined && stamp !== undefined && entry.stamp.hash !== stamp.hash;
        return {
          index,
          value: entry.value as T,
          replayed: true,
          stale,
          staleFacets: stale ? movedFacets(entry.stamp?.facets, stamp?.facets) : [],
          overridden: entry.overridden === true,
          ambient: entry.ambient ?? [],
          durationMs: 0,
          nested: this.takeNested(key),
          ...(entry.failed === undefined
            ? {}
            : {
                failed: entry.failed,
                thrown: new ReplayedFailure(`${kind}:${key}`, entry.failed),
              }),
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

    const startedAt = realNow();
    const settled: { value?: T; thrown?: unknown; failed?: RecordedFailure } = {};
    try {
      settled.value = await execute();
    } catch (cause) {
      // Handed back rather than raised: the caller has to write it to the log
      // before it goes anywhere, or the run's own log could not reproduce it.
      // The original error is kept so a caller that catches a typed provider
      // error still gets one.
      settled.thrown = cause;
      settled.failed = describeFailure(cause);
    }
    return {
      index,
      value: settled.value as T,
      replayed: false,
      stale: false,
      staleFacets: [],
      overridden: false,
      ambient: [],
      durationMs: realNow() - startedAt,
      nested: [],
      ...(settled.failed === undefined
        ? {}
        : { failed: settled.failed, thrown: settled.thrown }),
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
    const recorded = this.keyed.get(`${kind}:${key}`);
    if (recorded !== undefined) {
      return {
        index,
        value: recorded.value as T,
        replayed: true,
        stale: false,
        staleFacets: [],
        overridden: recorded.overridden === true,
        ambient: [],
        durationMs: 0,
        nested: [],
      };
    }

    const startedAt = realNow();
    const value = await execute();
    return {
      index,
      value,
      replayed: false,
      stale: false,
      staleFacets: [],
      overridden: false,
      ambient: [],
      durationMs: realNow() - startedAt,
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
    return this.keyed.get(`${kind}:${key}`)?.value;
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

/**
 * The names of the facets two stamps disagree on.
 *
 * A facet on one side and not the other counts as moved: the component was
 * present in one request and absent from the other, which is a change. Empty
 * when either side carries no facets at all, because then nothing was compared
 * — the caller has a stale effect it cannot explain, and saying so is the
 * truthful answer.
 *
 * Returned in whatever order the keys came in: the caller puts them in
 * `orderFacets`' order, which lives with the facet names themselves.
 */
export function movedFacets(
  was: Readonly<Record<string, string>> | undefined,
  now: Readonly<Record<string, string>> | undefined,
): string[] {
  if (was === undefined || now === undefined) return [];
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((n) => was[n] !== now[n]);
}

/** Whatever was thrown, reduced to the two fields that survive a JSON log. */
export function describeFailure(cause: unknown): RecordedFailure {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { name: "Error", message: String(cause) };
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
  /** Set when the log records a throw here rather than a value. */
  failed?: RecordedFailure;
  /** Digest of the model request this effect answered; becomes the entry's stamp. */
  requestHash?: string;
  /** The same digest per component; becomes the stamp's facets. */
  requestFacets?: Record<string, string>;
  /** Set by `applyOverrides`; a log read off disk never carries it. */
  overridden?: true;
  /** What the recorded tool call read outside the journal, if anything. */
  ambient?: AmbientSource[];
}

/** Values to serve in place of the recorded ones, keyed by effect key. */
export type Overrides = Readonly<Record<string, unknown>>;

/**
 * Substitute recorded values before they are replayed.
 *
 * This is the counterfactual: what would the agent have done if that search had
 * come back empty? The replaced value goes into the journal like any other, so
 * every step above it that runs live sees the new world, and every step below it
 * that replays is left visibly answering the old one — the request digest of a
 * replayed model call no longer matches once its conversation has changed, which
 * is exactly the `stale` marking a fork already carries.
 */
export function applyOverrides(
  effects: readonly RecordedEffect[],
  overrides: Overrides,
): RecordedEffect[] {
  const wanted = Object.keys(overrides);
  if (wanted.length === 0) return [...effects];

  const known = new Set(effects.map((e) => e.key));
  const missing = wanted.filter((key) => !known.has(key));
  if (missing.length > 0) {
    throw new Error(
      `this log records no effect ${missing.map((k) => `"${k}"`).join(", ")}. ` +
        `An override names the effect it replaces the way "retrace show" prints ` +
        `it — for example "step:2#0:search".`,
    );
  }

  // `failed` is dropped rather than kept: an override says what the effect
  // returned, and an effect cannot both return that and have thrown. Handing a
  // value to the call a run died on is the counterfactual worth having — what
  // the run would have done if the model had not refused to answer. `ambient`
  // goes the same way and for the same reason: the substituted value came from
  // you, not from a tool that read a clock to produce it.
  return effects.map(({ failed, ambient, ...e }) =>
    Object.hasOwn(overrides, e.key)
      ? { ...e, value: substitute(e, overrides[e.key]), overridden: true as const }
      : {
          ...e,
          ...(failed === undefined ? {} : { failed }),
          ...(ambient === undefined ? {} : { ambient }),
        },
  );
}

/**
 * A tool's recorded value is `{content, isError}`, but the thing worth
 * substituting is the text the tool handed back — so a bare value means that
 * text, and only a `content`-shaped object replaces the outcome wholesale.
 */
function substitute(effect: RecordedEffect, value: unknown): unknown {
  if (effect.kind !== "tool") return value;
  if (typeof value === "object" && value !== null && "content" in value) return value;
  return { content: typeof value === "string" ? value : JSON.stringify(value), isError: false };
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

/**
 * The same cut, made between two effects rather than between two steps:
 * everything recorded before `index` replays.
 *
 * A step is the coarsest place a fork can re-enter a run, and sometimes it is
 * too coarse. When the thing that went wrong is the third of a step's four
 * searches, cutting at the step throws away the model turn that asked for them
 * — and asking the model again gets you a different question, which is not the
 * counterfactual you wanted.
 */
export function journalUpToEffect(
  effects: readonly RecordedEffect[],
  index: number,
): JournalEntry[] {
  return effects
    .filter((e) => e.index < index)
    .sort((a, b) => a.index - b.index)
    .map((e, i) => entryOf(e, i));
}

/**
 * The effect a fork was told to go live at, or an error saying why it can't be
 * one.
 *
 * Only model and tool calls are fork points. A clock, id or random read
 * resolves by key rather than by position and outlives the fork point on
 * purpose — cutting the positional sequence there would leave the call that
 * asked for it replayed and the read itself served anyway, which is the same
 * run with a more confusing description.
 */
export function forkPointOf(effects: readonly RecordedEffect[], key: string): RecordedEffect {
  const at = effects.find((e) => e.key === key);
  if (at === undefined) {
    throw new Error(
      `this log records no effect "${key}". A fork point names the effect execution ` +
        `goes live at, the way "retrace show" prints it — for example "step:2#0:search".`,
    );
  }
  if (at.kind !== "model" && at.kind !== "tool") {
    throw new Error(
      `"${key}" is a ${at.kind} read inside "${key.split(NESTED)[0]}", not a call. A fork ` +
        `point is a model or tool call; reads resolve by key and are served wherever the ` +
        `run reaches them.`,
    );
  }
  return at;
}

/** One log event as a journal entry, renumbered to its position in the prefix. */
export function entryOf(effect: RecordedEffect, index: number): JournalEntry {
  return {
    index,
    kind: effect.kind,
    key: effect.key,
    value: effect.value,
    ...(effect.failed === undefined ? {} : { failed: effect.failed }),
    ...(effect.requestHash === undefined
      ? {}
      : {
          stamp: {
            hash: effect.requestHash,
            ...(effect.requestFacets === undefined ? {} : { facets: effect.requestFacets }),
          },
        }),
    ...(effect.overridden ? { overridden: true as const } : {}),
    ...(effect.ambient === undefined ? {} : { ambient: effect.ambient }),
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
    .map((e) => ({
      index: e.index,
      kind: e.kind,
      key: e.key,
      value: e.value,
      ...(e.overridden ? { overridden: true as const } : {}),
    }));
}
