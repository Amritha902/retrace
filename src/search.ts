import { DETERMINISTIC_KINDS, type Overrides, type RecordedEffect } from "./journal.ts";
import { effectsOf, fork, summarize, type ReenterOptions } from "./replay.ts";
import { newRunId, RunStore } from "./store.ts";
import type { AgentSpec, RunResult, RunStatus } from "./types.ts";

/** One fork, made and looked at. */
export interface SearchTrial {
  /** The fork point this trial cut at: steps below it replayed, this one ran live. */
  atStep: number;
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
  /** The forks it made, highest fork point first — the order it walks them. */
  tried: SearchTrial[];
  /** The highest fork point whose answer satisfied the predicate, if any did. */
  found?: SearchTrial;
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

  const tried: SearchTrial[] = [];
  let found: SearchTrial | undefined;
  let capped: string | undefined;

  for (let atStep = from; atStep >= downTo; atStep--) {
    if (options.maxForks !== undefined && tried.length >= options.maxForks) {
      capped =
        `capped at ${options.maxForks} fork${options.maxForks === 1 ? "" : "s"}: step ` +
        `${atStep}${atStep === downTo ? "" : ` down to ${downTo}`} was not tried`;
      break;
    }

    const result = await fork(parentRunId, {
      ...options,
      atStep,
      store,
      runId: newRunId("search"),
    });
    const trial: SearchTrial = {
      atStep,
      runId: result.runId,
      status: result.status,
      output: result.output,
      ...(result.error === undefined ? {} : { error: result.error }),
      matched: result.status === "completed" && matches(result),
      costUsd: result.totals.costUsd,
      billedUsd: result.totals.billedUsd,
      savedUsd: result.totals.savedUsd,
    };
    tried.push(trial);
    options.onTrial?.(trial);
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
    tried,
    ...(found === undefined ? {} : { found }),
    ...(stopped === undefined ? {} : { stopped }),
    costUsd: total((t) => t.costUsd),
    billedUsd: total((t) => t.billedUsd),
    savedUsd: total((t) => t.savedUsd),
  };
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
