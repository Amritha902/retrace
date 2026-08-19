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
  | "inconclusive";

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
 * Whether the forks were counterfactuals, checked rather than assumed.
 *
 * Each one is held against the run it came from rather than against the others,
 * because that is the comparison that says what a trial means: it replayed that
 * run's prefix and differs from it in the one value it was told to drop. Two
 * trials have no such obligation to each other — they cut at different points
 * and dropped different things.
 */
export interface AblationControl {
  /** How many forks were held to the run they came from. */
  forks: number;
  /** Effects they replayed from it, over all of them. */
  claimed: number;
  /** Positions inside those a fork was told to drop: one apiece. */
  excused: number;
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
  /** How many dropped answers moved the conclusion, and how many did not. */
  needed: number;
  spare: number;
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
  /** Give up after this many forks, however many calls are left. */
  maxForks?: number;
  /** Called as each trial finishes, so a caller can print an ablation as it runs. */
  onTrial?: (trial: AblationTrial) => void;
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

  for (const [i, call] of calls.entries()) {
    if (options.maxForks !== undefined && i >= options.maxForks) {
      const left = calls.length - i;
      stopped =
        `capped at ${plural(options.maxForks, "fork")}: ${plural(left, "recorded call")} ` +
        `${left === 1 ? "was" : "were"} not dropped`;
      break;
    }

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
      verdict: verdictOf(result.status, result.output, parent.output),
      claimed: held.claimed,
      staleFacets: staleFacets(result.events),
      costUsd: result.totals.costUsd,
      billedUsd: result.totals.billedUsd,
      savedUsd: result.totals.savedUsd,
    };
    trials.push(trial);
    options.onTrial?.(trial);
  }

  const total = (of: (t: AblationTrial) => number) => trials.reduce((sum, t) => sum + of(t), 0);
  return {
    runId: parentRunId,
    agent: parent.agent,
    recorded: parent.output,
    instead,
    trials,
    needed: trials.filter((t) => t.verdict === "needed").length,
    spare: trials.filter((t) => t.verdict === "spare").length,
    control: {
      forks: trials.length,
      claimed: total((t) => t.claimed),
      excused,
      ...(contradiction === undefined ? {} : { contradiction }),
      ok: contradiction === undefined,
    },
    ...(stopped === undefined ? {} : { stopped }),
    costUsd: total((t) => t.costUsd),
    billedUsd: total((t) => t.billedUsd),
    savedUsd: total((t) => t.savedUsd),
  };
}

/**
 * What one trial says about the answer it took away.
 *
 * A fork that did not complete never gave an answer, so comparing its output
 * against the recorded one would read a budget or a step limit as a dependency —
 * exactly the way `search` refuses to call an unfinished fork a match.
 */
function verdictOf(status: RunStatus, output: string, recorded: string): Ablation {
  if (status !== "completed") return "inconclusive";
  return output === recorded ? "spare" : "needed";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
