import { holdSharedPrefix, type SharedLog, type SharedPrefix } from "./compare.ts";
import { DETERMINISTIC_KINDS, type Overrides, type RecordedEffect } from "./journal.ts";
import { effectsOf, fork, summarize, type ReenterOptions } from "./replay.ts";
import { newRunId, RunStore } from "./store.ts";
import type { AgentSpec, RunResult, RunStatus } from "./types.ts";

/** One fork, made and looked at. */
export interface SearchRun {
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  /** Whether this fork's answer is the one the search was looking for. */
  matched: boolean;
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * One fork point, and what it answered when the search cut there.
 *
 * With `repeat` above one it is cut more than once, and the fork point holds
 * only if every fork made at it answered the same way — see `matched`.
 */
export interface SearchTrial {
  /** The fork point this trial cut at: steps below it replayed, this one ran live. */
  atStep: number;
  /** The forks made here, in the order they were made. Never empty. */
  runs: SearchRun[];
  /** The first of them, which the fields below describe. */
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  /**
   * Whether *every* fork made here answered what the search was looking for.
   * A fork that did not complete is not one that did, so it holds the trial
   * open too — `runs` is where a person reads which of the two happened.
   */
  matched: boolean;
  /** How many of them did. */
  matches: number;
  /** Some did and some didn't: this fork point does not answer the same twice. */
  unstable: boolean;
  /**
   * The forks made here held to the prefix they all replayed — the claim that
   * makes repeating a fork point a measurement rather than two runs. Absent
   * with a single fork, where there is nothing to hold against anything.
   */
  controlled?: SharedPrefix;
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * A walk down a run's fork points, and where it stopped.
 *
 * Every trial in it is a real run in the store — forkable, diffable and
 * verifiable like any other — so the search leaves behind the runs it made
 * rather than a summary of runs that are gone.
 */
export interface SearchReport {
  runId: string;
  agent: AgentSpec;
  /** The answer the recorded run gave. The default predicate is "not this". */
  recorded: string;
  /** The highest and lowest fork points this search was allowed to try. */
  from: number;
  downTo: number;
  /** How many times each fork point was cut. One unless the caller asked for more. */
  repeat: number;
  /** The fork points it tried, highest first — the order it walks them. */
  tried: SearchTrial[];
  /** The highest fork point every fork made at it satisfied the predicate, if any did. */
  found?: SearchTrial;
  /**
   * The highest fork point the change took at some of the time and not all of
   * it. Only reachable with `repeat` above one, and the reason to ask for it: a
   * fork point that answers two ways is not one a single fork could locate.
   */
  unstable?: SearchTrial;
  /** Why it stopped above `downTo`, when it did. */
  stopped?: string;
  /** What the trials cost at list price, what they were billed, and the gap. */
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

export interface SearchOptions extends Omit<ReenterOptions, "runId"> {
  /** The first fork point to try. Defaults to the run's last step. */
  from?: number;
  /** The last one it is allowed to try. Defaults to 0, a fork that replays nothing. */
  downTo?: number;
  /** Give up after this many forks, whatever `downTo` says. */
  maxForks?: number;
  /**
   * How many times to cut each fork point. One by default, which is one draw of
   * whatever the model does at that step.
   *
   * Above one, a fork point holds only if every fork made at it answers what
   * the search is looking for — so a model that would have moved the answer on
   * its own is reported as a fork point that did not settle, rather than as the
   * place a change took. The repeats are identical forks, and cost a live tail
   * each; the prefix below the cut is free for all of them, which is what makes
   * asking twice affordable at all.
   */
  repeat?: number;
  /**
   * What the search is looking for, given the whole of a fork's result.
   * Defaults to an answer that is not the recorded one.
   *
   * A fork that did not complete is never a match, whatever this returns: a run
   * that stopped on a budget, a limit or a throw did not answer, so there is
   * nothing for a predicate to be true of.
   */
  until?: (result: RunResult) => boolean;
  /** Called as each trial finishes, so a caller can print a search as it runs. */
  onTrial?: (trial: SearchTrial) => void;
}

/**
 * Find the highest fork point at which a change takes.
 *
 * Forking is not a thing you do once. You change the prompt, fork at step 7,
 * find the run comes out the same, and fork again lower — and the question you
 * are actually asking across all of that is *how far down does this have to
 * go*. Nothing here answered it; this does, and it answers it the cheap way
 * round, because the highest fork point is also the one with the most of the
 * prefix already paid for.
 *
 * So the walk goes downward. Each trial replays everything below its fork point
 * and executes the rest, the first one that satisfies the predicate ends the
 * search, and what the whole search cost is the sum of the live tails rather
 * than of the runs. A full re-run per attempt is the thing being avoided, and
 * the report says what that would have come to.
 */
export async function searchForkPoints(
  parentRunId: string,
  options: SearchOptions,
): Promise<SearchReport> {
  const store = options.store ?? new RunStore();
  const events = store.read(parentRunId);
  const parent = summarize(parentRunId, events);
  const recorded = effectsOf(events);

  // Forking at the step after the last one replays the whole log and executes
  // nothing, so it can only ever give back the recorded answer. The last step
  // is the highest fork point with a live step in it.
  const top = parent.steps - 1;
  const from = Math.min(options.from ?? top, top);
  const floor = overrideFloor(recorded, options.overrides ?? {});
  const downTo = Math.max(options.downTo ?? 0, floor.step);
  const matches = options.until ?? ((result) => result.output !== parent.output);
  const repeat = repeatCount(options.repeat);

  const tried: SearchTrial[] = [];
  let found: SearchTrial | undefined;
  let unstable: SearchTrial | undefined;
  let forks = 0;
  let capped: string | undefined;

  for (let atStep = from; atStep >= downTo; atStep--) {
    // A fork point costs `repeat` forks, and half a fork point answers nothing —
    // so the cap is checked against what trying this one would take rather than
    // against what has been spent.
    if (options.maxForks !== undefined && forks + repeat > options.maxForks) {
      capped =
        `capped at ${options.maxForks} fork${options.maxForks === 1 ? "" : "s"}: step ` +
        `${atStep}${atStep === downTo ? "" : ` down to ${downTo}`} was not tried`;
      break;
    }

    const runs: SearchRun[] = [];
    const logs: SharedLog[] = [];
    for (let i = 0; i < repeat; i++) {
      const result = await fork(parentRunId, {
        ...options,
        atStep,
        store,
        runId: newRunId("search"),
      });
      forks++;
      logs.push({ runId: result.runId, events: result.events });
      runs.push({
        runId: result.runId,
        status: result.status,
        output: result.output,
        ...(result.error === undefined ? {} : { error: result.error }),
        matched: result.status === "completed" && matches(result),
        costUsd: result.totals.costUsd,
        billedUsd: result.totals.billedUsd,
        savedUsd: result.totals.savedUsd,
      });
    }

    const first = runs[0]!;
    const hits = runs.filter((r) => r.matched).length;
    const trial: SearchTrial = {
      atStep,
      runs,
      runId: first.runId,
      status: first.status,
      output: first.output,
      ...(first.error === undefined ? {} : { error: first.error }),
      matched: hits === runs.length,
      matches: hits,
      unstable: hits > 0 && hits < runs.length,
      ...(repeat > 1 ? { controlled: holdSharedPrefix(logs) } : {}),
      costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
      billedUsd: runs.reduce((sum, r) => sum + r.billedUsd, 0),
      savedUsd: runs.reduce((sum, r) => sum + r.savedUsd, 0),
    };
    tried.push(trial);
    options.onTrial?.(trial);
    if (trial.unstable) unstable ??= trial;
    if (trial.matched) {
      found = trial;
      break;
    }
  }

  // Only worth saying when the search came up empty: a floor it never reached
  // and a cap it never hit are facts about a search that was going to stop
  // there, not about the answer it found above them.
  const stopped =
    found !== undefined
      ? undefined
      : (capped ?? (downTo > (options.downTo ?? 0) ? floor.why : undefined));

  const total = (of: (t: SearchTrial) => number) => tried.reduce((sum, t) => sum + of(t), 0);
  return {
    runId: parentRunId,
    agent: parent.agent,
    recorded: parent.output,
    from,
    downTo,
    repeat,
    tried,
    ...(found === undefined ? {} : { found }),
    ...(unstable === undefined ? {} : { unstable }),
    ...(stopped === undefined ? {} : { stopped }),
    costUsd: total((t) => t.costUsd),
    billedUsd: total((t) => t.billedUsd),
    savedUsd: total((t) => t.savedUsd),
  };
}

/**
 * How many times to cut each fork point.
 *
 * Zero forks at a fork point is a search that reports on nothing, so it is
 * refused rather than quietly taken as one — the caller asking for it means
 * something, and what they mean is not "the default".
 */
function repeatCount(repeat: number | undefined): number {
  if (repeat === undefined) return 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(
      `repeat has to be a whole number of forks per fork point, at least 1 — got ${repeat}`,
    );
  }
  return repeat;
}

/**
 * How far down a search carrying overrides can go before they stop meaning
 * anything.
 *
 * A substituted value is served in place of a log read, so it needs the fork to
 * still be reading the log there. Below that step the run consults the world
 * instead, and `fork` refuses the counterfactual rather than running a fork that
 * quietly ignores it — which would end the search on an error partway down. The
 * floor is the honest version of the same fact, reported rather than thrown.
 *
 * Clock, id, random and fetch reads are not part of it: they resolve by key
 * rather than by position and are served wherever the run reaches them, so a
 * substitution on one outlives every fork point.
 */
function overrideFloor(
  recorded: readonly RecordedEffect[],
  overrides: Overrides,
): { step: number; why: string } {
  const positional = recorded.filter(
    (e) =>
      Object.hasOwn(overrides, e.key) &&
      !(DETERMINISTIC_KINDS as readonly string[]).includes(e.kind),
  );
  // Effects come out of a log in execution order, so the last of these is the
  // one at the deepest step, and the fork has to read the log at least that far.
  const lowest = positional.at(-1);
  if (lowest === undefined) return { step: 0, why: "" };
  return {
    step: lowest.step + 1,
    why:
      `below step ${lowest.step + 1} the value set for "${lowest.key}" is no longer served ` +
      `from the log — that step runs live there, and the search stops rather than making a ` +
      `fork that ignores it`,
  };
}
