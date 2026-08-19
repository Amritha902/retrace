import { compareEvents } from "./compare.ts";
import { recordedToolCalls, type ToolOutcome } from "./recheck.ts";
import { fork, repeatCount, staleFacets, summarize, type ReenterOptions } from "./replay.ts";
import { newRunId, RunStore } from "./store.ts";
import type { AgentSpec, RunStatus } from "./types.ts";

/** What dropping one recorded answer did to the run's conclusion. */
export type Ablation =
  /** The run answered something else without it. */
  | "needed"
  /** The run answered the same thing anyway. */
  | "spare"
  /** The fork did not finish, so there is no answer to compare. */
  | "inconclusive"
  /**
   * Nothing about the drop can be read off what this trial answered — see
   * `Instability` for the two ways that happens.
   */
  | "unstable";

/**
 * Why a trial has no verdict to give, and they are different findings.
 *
 * `cut` is about the fork point rather than the drop: the run does not arrive
 * at its own answer from there even with nothing taken away, so nothing
 * measured at that cut is about a value. Every trial cutting there carries it.
 *
 * `answer` is about this trial alone, and only reachable with `repeat` above
 * one: the same value was dropped more than once and the run answered more than
 * one way without it. The cut is fine; what the drop does to the run is not one
 * thing.
 */
export type Instability = "cut" | "answer";

/** The value served in place of a dropped answer, unless the caller names another. */
export const DROPPED = "(no result)";

/** One fork made for a trial or a baseline, and what it answered. */
export interface AblationRun {
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * One recorded tool call, dropped, and what the run said without it.
 *
 * With `repeat` above one the drop is made more than once, and the trial has a
 * verdict only if every fork of it answered the same thing — see `instability`.
 */
export interface AblationTrial {
  step: number;
  /** The effect key of the dropped call, exactly as `show` prints it. */
  key: string;
  tool: string;
  /** What the model asked it, recovered from the response that asked. */
  input: unknown;
  /** What the log holds for it — the answer this trial took away. */
  recorded: ToolOutcome;
  /** The forks made with this value dropped, in the order they were made. */
  runs: AblationRun[];
  /** The first of them, which the three fields below describe. */
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  verdict: Ablation;
  /** How many of this trial's forks answered what the first one did. */
  alike: number;
  /** Which of the two things went wrong, when the verdict is `unstable`. */
  instability?: Instability;
  /**
   * The fork made at this trial's cut with nothing dropped, when one was made.
   * `diff` on the two is the drop's effect with everything else held: they
   * share a prefix, a fork point and a live tail, and differ in one value.
   */
  baselineRunId?: string;
  /**
   * How many effects one of this trial's forks replayed from the recorded run.
   * The claim that makes a trial a counterfactual rather than a second run: the
   * same prefix, minus one value. Every fork of a trial cuts at the same point,
   * so they all replay the same count.
   */
  claimed: number;
  /**
   * Components of the request the replayed prefix no longer answers. Empty is
   * the expected reading, and the reason this cut is worth making at the step
   * *after* the call: the drop moves the conversation only for steps that then
   * run live. Anything here is the module declaring tools the run was not
   * recorded with.
   */
  staleFacets: string[];
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * The same cut with nothing dropped.
 *
 * A trial's live tail is a fresh sample of the model, so an answer that is not
 * the recorded one differs for one of two reasons: the value that was taken
 * away, or the model answering differently at that fork point on its own. One
 * trial cannot tell those apart, and reading the second as the first is the
 * wrong answer this command can give — a call reported `needed` that nothing
 * ever depended on.
 *
 * A baseline asks the second question directly. Re-enter the run at the step
 * the trials cut at, drop nothing, and see whether it still arrives where it
 * did. If it does, the fork point reproduces and the trials there are measuring
 * their drop. If it does not, nothing measured there is about a drop, and the
 * trials say so rather than claiming a dependency.
 *
 * One is made per cut rather than per trial, because the cut is what the trials
 * at a step have in common: every call recorded in step 3 is dropped from a fork
 * at step 4, and one fork at step 4 answers for all of them. `repeat` cuts it
 * that many times, and then the cut has to arrive at the recorded answer every
 * one of them to count as reproducing.
 */
export interface AblationBaseline {
  /** The cut the trials sharing this baseline all make. */
  atStep: number;
  /** The forks made at this cut with nothing dropped, in the order made. */
  runs: AblationRun[];
  /** The first of them, which the three fields below describe. */
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  /** How many of them arrived at the recorded answer. */
  held: number;
  /**
   * Whether *every* fork made here arrived where the recorded run did. False is
   * the finding: from this point the run does not reproduce itself, so a trial
   * answering something else there has said nothing about the value it dropped.
   */
  reproduced: boolean;
  /** Effects one of them replayed from the recorded run, none of them substituted. */
  claimed: number;
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * Whether the forks were counterfactuals, checked rather than assumed.
 *
 * Each one is held against the run it came from rather than against the others,
 * because that is the comparison that says what a trial means: it replayed that
 * run's prefix and differs from it in the one value it was told to drop. Two
 * trials have no such obligation to each other — they cut at different points
 * and dropped different things.
 */
export interface AblationControl {
  /** How many trial forks were held to the run they came from. */
  forks: number;
  /** Effects they replayed from it, over all of them. */
  claimed: number;
  /** Positions inside those a fork was told to drop: one apiece. */
  excused: number;
  /**
   * Reads above each trial's cut that it took out of the run's own key table
   * rather than the world, over all of them. The tight cut makes the prefix
   * free; this is what keeps the live tail above it a counterfactual rather
   * than a second visit to the world. See `KeptWorld`.
   */
  kept: number;
  /**
   * Baseline forks held the same way, and the effects they replayed. They cut
   * where the trials cut and substitute nothing, so every position they
   * replayed is owed to the run unexcused.
   */
  baselines: number;
  baselineClaimed: number;
  /** Set when a fork's replayed prefix is not the prefix the run recorded. */
  contradiction?: string;
  ok: boolean;
}

/**
 * Every recorded answer dropped in turn, and what the run's conclusion did
 * without it.
 *
 * Each trial is a real run in the store — forkable, diffable and verifiable
 * like any other — so an ablation leaves behind the runs it made rather than a
 * summary of runs that are gone.
 */
export interface AblationReport {
  runId: string;
  agent: AgentSpec;
  /** The answer the recorded run gave, which every trial is asked against. */
  recorded: string;
  /** The stand-in each dropped answer was replaced with. */
  instead: string;
  trials: AblationTrial[];
  /** One per cut the trials made, in cut order. Empty when they were skipped. */
  baselines: AblationBaseline[];
  /** How many times each answer was dropped. One unless the caller asked for more. */
  repeat: number;
  /** How many dropped answers moved the conclusion, and how many did not. */
  needed: number;
  spare: number;
  /** Trials that measured nothing, for either of the reasons `Instability` names. */
  unstable: number;
  control: AblationControl;
  /** Why it stopped short of the calls it had left, when it did. */
  stopped?: string;
  /** What the trials cost at list price, what they were billed, and the gap. */
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

export interface AblationOptions
  extends Omit<ReenterOptions, "runId" | "overrides" | "agent" | "input"> {
  /** Drop only calls to these tools. Every recorded call by default. */
  only?: readonly string[];
  /** What to serve in place of a dropped answer. `DROPPED` by default. */
  instead?: string;
  /**
   * Give up after this many forks, however many calls are left. A drop costs
   * `repeat` of them, and half a drop answers nothing, so a cap that cannot
   * afford a whole one stops above it. Baselines are not counted against it —
   * they are made per cut the trials it allows arrive at.
   */
  maxForks?: number;
  /**
   * Re-run each cut with nothing dropped, to find out whether the run
   * reproduces from there at all. On by default: without it a trial cannot say
   * whether its answer moved because of the drop or because the model did.
   */
  baseline?: boolean;
  /**
   * How many times to make each drop. One by default, which is one draw of
   * whatever the model does with that value taken away.
   *
   * Above one, a trial has a verdict only if every fork of it answered the same
   * thing — so a run that does not give one answer without the dropped value
   * comes back `unstable` rather than as a dependency it never had. The
   * baselines are cut the same number of times, and a cut reproduces only if
   * all of them arrived at the recorded answer. The prefix below each cut is
   * free every time, which is what makes asking twice affordable at all.
   */
  repeat?: number;
  /** Called as each trial finishes, so a caller can print an ablation as it runs. */
  onTrial?: (trial: AblationTrial) => void;
  /** Called as each baseline finishes, before any trial measured against it. */
  onBaseline?: (baseline: AblationBaseline) => void;
}

/**
 * Ask which of the things a run learned its answer actually depended on.
 *
 * A finished run is a conclusion and a pile of tool results that led to it, and
 * nothing in the log says which of those results the conclusion rests on. The
 * only way to find out is to take one away and see whether the answer moves —
 * which used to mean running the agent again per call, and now means one live
 * tail per call, because everything below the drop comes out of the log.
 *
 * Each trial forks at the step *after* the call it drops. That is the tightest
 * cut the log allows: the drop is still served from the log, the model turn that
 * asked for the call and every call beside it replay exactly as recorded, and
 * the first step to see the changed world is the first step that runs live. So
 * a trial's replayed prefix is not merely free, it is still answering the
 * questions it was recorded against — nothing below the drop goes `stale`, and
 * the substituted value is the whole of what separates the trial from the run.
 *
 * What that still leaves is a live tail, which is a fresh sample of the model.
 * So each cut is also re-entered with nothing dropped, and a cut the run does
 * not reproduce from carries no verdicts — see `AblationBaseline`. One baseline
 * serves every trial cutting at the same step. That rules out the cut; what it
 * cannot rule out is the drop itself being answered two ways, and `repeat` is
 * what asks about that, by making each drop more than once.
 *
 * The trials run one after another rather than at once, for the reason a sweep's
 * arms do: the tails execute tools, and this is not the place to introduce a
 * concurrency the recorded run never had.
 */
export async function ablateRun(
  parentRunId: string,
  options: AblationOptions,
): Promise<AblationReport> {
  const store = options.store ?? new RunStore();
  const events = store.read(parentRunId);
  const parent = summarize(parentRunId, events);
  const instead = options.instead ?? DROPPED;

  const wanted = options.only === undefined ? undefined : new Set(options.only);
  const calls = recordedToolCalls(events).filter(
    (c) => wanted === undefined || wanted.has(c.call.name),
  );

  const repeat = repeatCount(options.repeat, "drop");
  const trials: AblationTrial[] = [];
  let contradiction: string | undefined;
  let excused = 0;
  let stopped: string | undefined;

  // A drop costs `repeat` forks, and half a drop answers nothing, so the cap is
  // spent in whole trials — the same arithmetic `search` does over fork points.
  const cap = options.maxForks;
  const dropped = cap === undefined ? calls : calls.slice(0, Math.floor(cap / repeat));
  if (cap !== undefined && dropped.length < calls.length) {
    const left = calls.length - dropped.length;
    stopped =
      `capped at ${plural(cap, "fork")}: ${plural(left, "recorded call")} ` +
      `${left === 1 ? "was" : "were"} not dropped`;
  }

  // Every trial cuts at the step after the call it drops, so the cuts a set of
  // trials makes are far fewer than the trials: one baseline per cut answers
  // for every call recorded in the step below it.
  const baselines: AblationBaseline[] = [];
  const byCut = new Map<number, AblationBaseline>();
  if (options.baseline !== false) {
    for (const atStep of [...new Set(dropped.map((c) => c.step + 1))].sort((a, b) => a - b)) {
      const runs: AblationRun[] = [];
      let claimed = 0;
      for (let cut = 0; cut < repeat; cut++) {
        const result = await fork(parentRunId, {
          ...options,
          atStep,
          overrides: {},
          store,
          runId: newRunId("ablate"),
        });
        const held = compareEvents(parentRunId, events, result.runId, result.events);
        contradiction ??= held.contradiction;
        claimed = held.claimed;
        runs.push(runOf(result));
      }

      const first = runs[0]!;
      const arrived = runs.filter(
        (r) => r.status === "completed" && r.output === parent.output,
      ).length;
      const made: AblationBaseline = {
        atStep,
        runs,
        runId: first.runId,
        status: first.status,
        output: first.output,
        ...(first.error === undefined ? {} : { error: first.error }),
        held: arrived,
        // Every cut of it, not merely the first: a cut that arrived once and
        // wandered off the second time is exactly the fork point whose trials
        // cannot be read, which is the whole question a baseline is asking.
        reproduced: arrived === runs.length,
        claimed,
        ...totals(runs),
      };
      baselines.push(made);
      byCut.set(atStep, made);
      options.onBaseline?.(made);
    }
  }

  let claimedByTrials = 0;
  let keptByTrials = 0;
  let claimedByBaselines = 0;
  for (const made of baselines) claimedByBaselines += made.claimed * made.runs.length;

  for (const call of dropped) {
    const runs: AblationRun[] = [];
    let claimed = 0;
    let facets: string[] = [];
    for (let cut = 0; cut < repeat; cut++) {
      const result = await fork(parentRunId, {
        ...options,
        // The step after the one the call is in: everything recorded up to and
        // including its own step replays, the dropped value among it, and the
        // first step to read the changed world runs live.
        atStep: call.step + 1,
        overrides: { [call.key]: instead },
        store,
        runId: newRunId("ablate"),
      });
      const held = compareEvents(parentRunId, events, result.runId, result.events);
      contradiction ??= held.contradiction;
      excused += held.excused;
      claimedByTrials += held.claimed;
      keptByTrials += held.world.held.length;
      claimed = held.claimed;
      if (cut === 0) facets = staleFacets(result.events);
      runs.push(runOf(result));
    }

    const first = runs[0]!;
    const baseline = byCut.get(call.step + 1);
    const alike = runs.filter((r) => sameAnswer(r, first)).length;
    const settled = alike === runs.length;
    const trial: AblationTrial = {
      step: call.step,
      key: call.key,
      tool: call.call.name,
      input: call.call.input,
      recorded: call.value,
      runs,
      runId: first.runId,
      status: first.status,
      output: first.output,
      ...(first.error === undefined ? {} : { error: first.error }),
      verdict: verdictOf(first.status, first.output, parent.output, settled, baseline),
      alike,
      ...instabilityOf(settled, baseline),
      ...(baseline === undefined ? {} : { baselineRunId: baseline.runId }),
      claimed,
      staleFacets: facets,
      ...totals(runs),
    };
    trials.push(trial);
    options.onTrial?.(trial);
  }

  const sum = (of: (r: { costUsd: number; billedUsd: number; savedUsd: number }) => number) =>
    [...trials, ...baselines].reduce((n, r) => n + of(r), 0);

  return {
    runId: parentRunId,
    agent: parent.agent,
    recorded: parent.output,
    instead,
    trials,
    baselines,
    repeat,
    needed: trials.filter((t) => t.verdict === "needed").length,
    spare: trials.filter((t) => t.verdict === "spare").length,
    unstable: trials.filter((t) => t.verdict === "unstable").length,
    control: {
      forks: trials.length * repeat,
      claimed: claimedByTrials,
      excused,
      kept: keptByTrials,
      baselines: baselines.length * repeat,
      baselineClaimed: claimedByBaselines,
      ...(contradiction === undefined ? {} : { contradiction }),
      ok: contradiction === undefined,
    },
    ...(stopped === undefined ? {} : { stopped }),
    costUsd: sum((r) => r.costUsd),
    billedUsd: sum((r) => r.billedUsd),
    savedUsd: sum((r) => r.savedUsd),
  };
}

/**
 * What one trial says about the answer it took away.
 *
 * A trial that did not answer the same thing every time it was made says
 * nothing about the drop at all, and that is checked before anything else: the
 * output the other three fields describe is one of several, so reading a
 * verdict off it would be reading one draw.
 *
 * A fork that did not complete never gave an answer, so comparing its output
 * against the recorded one would read a budget or a step limit as a dependency —
 * exactly the way `search` refuses to call an unfinished fork a match.
 *
 * A cut the run does not reproduce from is the same refusal one step out. The
 * comparison is against the recorded answer, and if the baseline could not
 * arrive at it either, then a trial that missed it missed it for a reason this
 * command cannot separate from the drop.
 */
function verdictOf(
  status: RunStatus,
  output: string,
  recorded: string,
  settled: boolean,
  baseline: AblationBaseline | undefined,
): Ablation {
  if (!settled) return "unstable";
  if (status !== "completed") return "inconclusive";
  if (baseline !== undefined && !baseline.reproduced) return "unstable";
  return output === recorded ? "spare" : "needed";
}

/**
 * Which of the two instabilities a trial has, when it has one.
 *
 * A cut that does not reproduce comes first even where the trial also failed to
 * settle: it is the wider fact, it covers every trial at that step rather than
 * this one, and re-cutting a fork point the run does not return to would not
 * settle anything.
 */
function instabilityOf(
  settled: boolean,
  baseline: AblationBaseline | undefined,
): { instability?: Instability } {
  if (baseline !== undefined && !baseline.reproduced) return { instability: "cut" };
  return settled ? {} : { instability: "answer" };
}

/**
 * Whether two forks of one trial answered the same thing.
 *
 * The status is part of it, and so is the error: a fork that stopped on a budget
 * and one that answered are not the same answer whatever their output strings
 * say, and two that died differently did not agree either. `sweep` holds the
 * cuts of an arm to the same rule.
 */
function sameAnswer(a: AblationRun, b: AblationRun): boolean {
  return a.status === b.status && a.output === b.output && a.error === b.error;
}

function runOf(result: {
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  totals: { costUsd: number; billedUsd: number; savedUsd: number };
}): AblationRun {
  return {
    runId: result.runId,
    status: result.status,
    output: result.output,
    ...(result.error === undefined ? {} : { error: result.error }),
    costUsd: result.totals.costUsd,
    billedUsd: result.totals.billedUsd,
    savedUsd: result.totals.savedUsd,
  };
}

/** What a trial or a baseline came to, over every fork made for it. */
function totals(runs: readonly AblationRun[]): {
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
} {
  const sum = (of: (r: AblationRun) => number) => runs.reduce((n, r) => n + of(r), 0);
  return {
    costUsd: sum((r) => r.costUsd),
    billedUsd: sum((r) => r.billedUsd),
    savedUsd: sum((r) => r.savedUsd),
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
