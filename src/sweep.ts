import { holdSharedPrefix, type SharedLog } from "./compare.ts";
import type { Overrides } from "./journal.ts";
import { fork, staleFacets, summarize, type ForkPoint, type ReenterOptions } from "./replay.ts";
import { newRunId, RunStore } from "./store.ts";
import type { AgentSpec, RunStatus } from "./types.ts";

/** One thing to try at the fork point: a change, and a name to read it under. */
export interface SweepArm {
  /** What this arm is trying. Defaults to its position, and must be unique. */
  name?: string;
  /** Fields to change relative to the recorded agent. The usual variation. */
  agent?: Partial<AgentSpec>;
  input?: string;
  /** Values to serve in place of recorded ones — the world varied instead of the agent. */
  overrides?: Overrides;
}

/**
 * How an arm ended: the status of the run it made, or `not_run` for one the
 * runtime refused before it started. An override that would be served to nobody
 * at this fork point is the common way to get there, and a `not_run` arm has no
 * run in the store — the rest of the sweep goes ahead without it.
 */
export type ArmStatus = RunStatus | "not_run";

/** One arm, forked and looked at. */
export interface SweepTrial {
  name: string;
  /** Absent when the arm was refused before it started — see `error`. */
  runId?: string;
  status: ArmStatus;
  output: string;
  error?: string;
  /**
   * Which components of the request moved under the prefix this arm replayed —
   * `system` for a rewritten prompt, `conversation` for a substituted value.
   * The arm's own log saying what the arm changed.
   */
  staleFacets: string[];
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

/**
 * Whether the arms were a controlled experiment, checked rather than assumed.
 *
 * Every arm cut the same log at the same point, so below it they cannot hold
 * different values — and that is checkable from the arms' own logs, without the
 * run they came from. It is what separates a sweep from running the agent N
 * times: the arms differ in what you varied and share everything underneath.
 */
export interface SweepControl {
  /** How many arms were held against each other. Below two there is nothing to check. */
  arms: number;
  /** Leading effects every arm was obliged to hold identically: the free prefix. */
  claimed: number;
  /** Effects inside it an arm was told to serve a different value at. */
  excused: number;
  /** Set when two arms disagree somewhere they both replayed. */
  contradiction?: string;
  ok: boolean;
}

/**
 * A set of arms tried at one fork point, and what each of them answered.
 *
 * Every arm is a real run in the store — forkable, diffable and verifiable like
 * any other — so a sweep leaves behind the runs it made rather than a summary
 * of runs that are gone.
 */
export interface SweepReport {
  runId: string;
  agent: AgentSpec;
  /** The answer the recorded run gave, which every arm is an alternative to. */
  recorded: string;
  /** Where the arms cut, as they were asked to. */
  atStep?: number;
  atEffect?: string;
  arms: SweepTrial[];
  control: SweepControl;
  /** What the arms cost at list price, what they were billed, and the gap. */
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
}

export interface SweepOptions extends Omit<ReenterOptions, "runId"> {
  /** What to try. Each arm's fields are merged over the sweep's own. */
  arms: readonly SweepArm[];
  /** Called as each arm finishes, so a caller can print a sweep as it runs. */
  onTrial?: (trial: SweepTrial) => void;
}

/**
 * Try several changes at one fork point, off one replayed prefix.
 *
 * `search` varies the fork point and fixes the change; this is the other half
 * of the same question — fix the fork point and vary the change. It is the
 * thing the free prefix was for: five prompts tried at step 7 of a twelve-step
 * run cost five live tails rather than five runs, and the report says what the
 * difference came to.
 *
 * The arms run one after another rather than at once. The prefix is free either
 * way, but the live tails execute tools, and a sweep is not the place to
 * introduce a concurrency the recorded run never had.
 */
export async function sweepForkPoint(
  parentRunId: string,
  options: SweepOptions & ForkPoint,
): Promise<SweepReport> {
  const store = options.store ?? new RunStore();
  const parent = summarize(parentRunId, store.read(parentRunId));
  const names = armNames(options.arms);

  const trials: SweepTrial[] = [];
  const logs: SharedLog[] = [];

  for (const [i, arm] of options.arms.entries()) {
    const name = names[i]!;
    let trial: SweepTrial;
    try {
      const result = await fork(parentRunId, {
        ...options,
        agent: { ...options.agent, ...arm.agent },
        input: arm.input ?? options.input,
        overrides: { ...options.overrides, ...arm.overrides },
        store,
        runId: newRunId("sweep"),
      });
      logs.push({ runId: result.runId, events: result.events });
      trial = {
        name,
        runId: result.runId,
        status: result.status,
        output: result.output,
        ...(result.error === undefined ? {} : { error: result.error }),
        staleFacets: staleFacets(result.events),
        costUsd: result.totals.costUsd,
        billedUsd: result.totals.billedUsd,
        savedUsd: result.totals.savedUsd,
      };
    } catch (cause) {
      // A fork the runtime declines to make — an override this fork point would
      // serve to nobody is the one that happens — takes the arm out of the
      // sweep and nothing else. The arms are independent questions, and the
      // answers to the rest are still worth having.
      trial = {
        name,
        status: "not_run",
        output: "",
        error: cause instanceof Error ? cause.message : String(cause),
        staleFacets: [],
        costUsd: 0,
        billedUsd: 0,
        savedUsd: 0,
      };
    }
    trials.push(trial);
    options.onTrial?.(trial);
  }

  const total = (of: (t: SweepTrial) => number) => trials.reduce((sum, t) => sum + of(t), 0);
  return {
    runId: parentRunId,
    agent: parent.agent,
    recorded: parent.output,
    ...(options.atStep === undefined ? {} : { atStep: options.atStep }),
    ...(options.atEffect === undefined ? {} : { atEffect: options.atEffect }),
    arms: trials,
    control: controlOf(logs),
    costUsd: total((t) => t.costUsd),
    billedUsd: total((t) => t.billedUsd),
    savedUsd: total((t) => t.savedUsd),
  };
}

/**
 * Names to read the arms under. An arm may leave it to its position, but two
 * arms sharing a name would make the report unable to say which answered what,
 * so that is refused rather than printed twice.
 */
function armNames(arms: readonly SweepArm[]): string[] {
  const names = arms.map((arm, i) => arm.name ?? `arm ${i + 1}`);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(
        `two arms of this sweep are named "${name}" — a sweep reports one answer per ` +
          `arm, so the names have to tell them apart`,
      );
    }
    seen.add(name);
  }
  return names;
}

/**
 * Hold the arms to the prefix they all replayed.
 *
 * Two arms of a sweep are siblings — both forked from the same run at the same
 * point — so this is the general sibling check under the name a sweep reads it
 * under. `search` holds the repeats of one fork point the same way.
 */
function controlOf(logs: readonly SharedLog[]): SweepControl {
  const { runs, ...rest } = holdSharedPrefix(logs);
  return { arms: runs, ...rest };
}
