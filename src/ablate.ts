import { compareEvents } from "./compare.ts";
import { recordedToolCalls, type ToolOutcome } from "./recheck.ts";
import { fork, staleFacets, summarize, type ReenterOptions } from "./replay.ts";
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
   * The run does not arrive at the recorded answer from this cut even with
   * nothing dropped, so what the trial answered is not a fact about the drop.
   */
  | "unstable";

/** The value served in place of a dropped answer, unless the caller names another. */
export const DROPPED = "(no result)";

/** One recorded tool call, dropped, and what the run said without it. */
export interface AblationTrial {
  step: number;
  /** The effect key of the dropped call, exactly as `show` prints it. */
  key: string;
  tool: string;
  /** What the model asked it, recovered from the response that asked. */
  input: unknown;
  /** What the log holds for it — the answer this trial took away. */
  recorded: ToolOutcome;
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  verdict: Ablation;
  /**
   * The fork made at this trial's cut with nothing dropped, when one was made.
   * `diff` on the two is the drop's effect with everything else held: they
   * share a prefix, a fork point and a live tail, and differ in one value.
   */
  baselineRunId?: string;
  /**
   * How many effects this fork replayed from the recorded run, and whether it
   * held them. The claim that makes one trial a counterfactual rather than a
   * second run: the same prefix, minus one value.
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
 * at step 4, and one fork at step 4 answers for all of them.
 */
export interface AblationBaseline {
  /** The cut the trials sharing this baseline all make. */
  atStep: number;
  runId: string;
  status: RunStatus;
  output: string;
  error?: string;
  /**
   * Whether it arrived where the recorded run did. False is the finding: from
   * this point the run does not reproduce itself, so a trial answering
   * something else there has said nothing about the value it dropped.
   */
  reproduced: boolean;
  /** Effects it replayed from the recorded run, none of them substituted. */
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
   * Baselines held the same way, and the effects they replayed. They cut where
   * the trials cut and substitute nothing, so every position they replayed is
   * owed to the run unexcused.
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
  /** How many dropped answers moved the conclusion, and how many did not. */
  needed: number;
  spare: number;
  /** Trials cut at a point the run does not reproduce from, so they measured nothing. */
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
   * Give up after this many drops, however many calls are left. Baselines are
   * not counted against it — one is made per cut the trials it allows arrive at.
   */
  maxForks?: number;
  /**
   * Re-run each cut with nothing dropped, to find out whether the run
   * reproduces from there at all. On by default: without it a trial cannot say
   * whether its answer moved because of the drop or because the model did.
   */
  baseline?: boolean;
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
 * serves every trial cutting at the same step.
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

  const trials: AblationTrial[] = [];
  let contradiction: string | undefined;
  let excused = 0;
  let stopped: string | undefined;

  const cap = options.maxForks;
  const dropped = cap === undefined ? calls : calls.slice(0, cap);
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
      const result = await fork(parentRunId, {
        ...options,
        atStep,
        overrides: {},
        store,
        runId: newRunId("ablate"),
      });
      const held = compareEvents(parentRunId, events, result.runId, result.events);
      contradiction ??= held.contradiction;

      const made: AblationBaseline = {
        atStep,
        runId: result.runId,
        status: result.status,
        output: result.output,
        ...(result.error === undefined ? {} : { error: result.error }),
        reproduced: result.status === "completed" && result.output === parent.output,
        claimed: held.claimed,
        costUsd: result.totals.costUsd,
        billedUsd: result.totals.billedUsd,
        savedUsd: result.totals.savedUsd,
      };
      baselines.push(made);
      byCut.set(atStep, made);
      options.onBaseline?.(made);
    }
  }

  for (const call of dropped) {
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

    const baseline = byCut.get(call.step + 1);
    const trial: AblationTrial = {
      step: call.step,
      key: call.key,
      tool: call.call.name,
      input: call.call.input,
      recorded: call.value,
      runId: result.runId,
      status: result.status,
      output: result.output,
      ...(result.error === undefined ? {} : { error: result.error }),
      verdict: verdictOf(result.status, result.output, parent.output, baseline),
      ...(baseline === undefined ? {} : { baselineRunId: baseline.runId }),
      claimed: held.claimed,
      staleFacets: staleFacets(result.events),
      costUsd: result.totals.costUsd,
      billedUsd: result.totals.billedUsd,
      savedUsd: result.totals.savedUsd,
    };
    trials.push(trial);
    options.onTrial?.(trial);
  }

  const sum = (of: (r: { costUsd: number; billedUsd: number; savedUsd: number }) => number) =>
    [...trials, ...baselines].reduce((n, r) => n + of(r), 0);
  const claimedBy = (rs: readonly { claimed: number }[]) =>
    rs.reduce((n, r) => n + r.claimed, 0);

  return {
    runId: parentRunId,
    agent: parent.agent,
    recorded: parent.output,
    instead,
    trials,
    baselines,
    needed: trials.filter((t) => t.verdict === "needed").length,
    spare: trials.filter((t) => t.verdict === "spare").length,
    unstable: trials.filter((t) => t.verdict === "unstable").length,
    control: {
      forks: trials.length,
      claimed: claimedBy(trials),
      excused,
      baselines: baselines.length,
      baselineClaimed: claimedBy(baselines),
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
  baseline: AblationBaseline | undefined,
): Ablation {
  if (status !== "completed") return "inconclusive";
  if (baseline !== undefined && !baseline.reproduced) return "unstable";
  return output === recorded ? "spare" : "needed";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
