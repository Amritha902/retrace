import { orderFacets, run, type RunOptions } from "./agent.ts";
import {
  applyOverrides,
  deterministicEntries,
  entryOf,
  forkPointOf,
  Journal,
  journalUpToEffect,
  journalUpToStep,
  type DivergencePolicy,
  type JournalEntry,
  type Overrides,
  type RecordedEffect,
} from "./journal.ts";
import { newRunId, RunStore } from "./store.ts";
import type {
  AgentSpec,
  BudgetSpec,
  ForkOrigin,
  Provider,
  RetraceEvent,
  RunResult,
  RunStatus,
  Tool,
  Totals,
} from "./types.ts";

export interface RunSummary {
  runId: string;
  agent: AgentSpec;
  input: string;
  provider: string;
  status: RunStatus;
  output: string;
  error?: string;
  totals?: Totals;
  steps: number;
  startedAt: number;
  forkedFrom?: ForkOrigin;
}

/** Read a run's log back without executing anything. */
export function inspect(runId: string, store: RunStore = new RunStore()): RunSummary {
  return summarize(runId, store.read(runId));
}

/** The same summary, from events already in hand. */
export function summarize(runId: string, events: readonly RetraceEvent[]): RunSummary {
  const started = events.find((e) => e.type === "run.started");
  if (!started || started.type !== "run.started") {
    throw new Error(`run "${runId}" has no run.started event — the log is truncated or not a run`);
  }
  const finished = events.find((e) => e.type === "run.finished");
  const steps = events.filter((e) => e.type === "step.started").length;

  return {
    runId,
    agent: started.agent,
    input: started.input,
    provider: started.provider,
    status: finished?.type === "run.finished" ? finished.status : "running",
    output: finished?.type === "run.finished" ? (finished.output ?? "") : "",
    ...(finished?.type === "run.finished" && finished.error !== undefined
      ? { error: finished.error }
      : {}),
    ...(finished?.type === "run.finished" ? { totals: finished.totals } : {}),
    steps,
    startedAt: started.t,
    ...(started.forkedFrom ? { forkedFrom: started.forkedFrom } : {}),
  };
}

/** Pull the recorded effects out of a log, in execution order. */
export function effectsOf(events: readonly RetraceEvent[]) {
  return events
    .filter((e): e is Extract<RetraceEvent, { type: "effect" }> => e.type === "effect")
    .sort((a, b) => a.index - b.index);
}

/**
 * The effects a run served from a log that were recorded against a different
 * request than the one it built.
 *
 * In a fork this is the measure of what the replayed prefix is no longer
 * answering: change the system prompt and every step below the fork point shows
 * up here. In a plain replay it should be empty, and anything in it is the loop
 * building a request out of something the journal does not cover.
 */
export function staleEffects(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => e.stale === true);
}

/**
 * What changed, across everything this run replayed stale — the union of the
 * components its recorded requests and its rebuilt ones disagree on.
 *
 * This is the line worth reading after a fork. A rewritten prompt should come
 * back `["system"]`; anything else in the list is a difference between this run
 * and its parent that you did not ask for. Empty when nothing is stale, and
 * also when the parent's log predates facets and there was nothing to compare —
 * `staleEffects` is what says whether anything is stale at all.
 */
export function staleFacets(events: readonly RetraceEvent[]): string[] {
  return orderFacets(staleEffects(events).flatMap((e) => e.staleFacets ?? []));
}

/** The effects a run served from a log after being told to change their value. */
export function overriddenEffects(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => e.overridden === true);
}

/**
 * The tool calls that reached past the journal for a time, an id or a random
 * draw while they ran.
 *
 * Everything else here works to make a replayed prefix free; this is the one
 * measure of whether a replayed prefix is a *reproduction*. A tool that read
 * `Date.now()` recorded what it happened to say once, and a fork replaying that
 * answer is holding a snapshot rather than something the tool would say again.
 */
export function ambientEffects(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => (e.ambient?.length ?? 0) > 0);
}

/**
 * Everything a re-entry into a recorded run takes except where to re-enter it.
 * `fork` adds the fork point; `replay` and `resume` fix it themselves.
 */
export interface ReenterOptions {
  provider: Provider;
  tools?: Tool[];
  /** Fields to change relative to the parent. This is the point of forking. */
  agent?: Partial<AgentSpec>;
  input?: string;
  /**
   * Values to serve in place of the recorded ones, keyed by effect key —
   * `{ "step:2#0:search": "no results" }`. The counterfactual: the steps that
   * run live see the substituted world, and the replayed steps between the
   * substitution and the fork point come back marked `stale`, because their
   * recorded answers were given to a conversation that no longer exists.
   */
  overrides?: Overrides;
  budget?: BudgetSpec;
  store?: RunStore;
  runId?: string;
  /**
   * "strict" (default) fails loudly if the fork asks for an effect the parent
   * log doesn't have in that slot. "live" treats the mismatch as the divergence
   * point and executes from there.
   */
  onDivergence?: DivergencePolicy;
  /**
   * Execute tools marked `irreversible` in the live tail instead of refusing to.
   *
   * Off by default, and this is the one place the default bites: the prefix a
   * re-entry replays is free of side effects because nothing runs, and the tail
   * is not. A tool that says it cannot be repeated is stopped at by name rather
   * than repeated quietly — see `IrreversibleToolError`.
   */
  allowIrreversible?: boolean;
  onEvent?: RunOptions["onEvent"];
  /**
   * Fragments of each assistant turn. Steps served from the log deliver theirs
   * reconstructed and flagged `replayed`, so a fork renders the same way above
   * and below its fork point.
   */
  onStream?: RunOptions["onStream"];
}

/**
 * Where a fork stops reading the log and starts executing. One or the other,
 * never both — they are two ways of naming the same boundary, and a caller that
 * gave both would be saying which one it meant twice.
 */
export type ForkPoint =
  | {
      /**
       * Steps below this index are served from the parent's log. Step `atStep`
       * is the first one that runs live, so `atStep: 0` is a fresh run with the
       * parent's configuration and `atStep: Infinity` is a full replay.
       */
      atStep: number;
      atEffect?: never;
    }
  | {
      /**
       * The effect execution goes live at, keyed the way `show` prints it —
       * `"step:2#1:search"`. Everything recorded before it replays, including
       * the earlier part of its own step, so the model turn that asked for the
       * call is kept and only the call and what follows it run for real.
       */
      atEffect: string;
      atStep?: never;
    };

export type ForkOptions = ReenterOptions & ForkPoint;

/**
 * Re-run a recorded run with something changed.
 *
 * The prefix below the fork point comes out of the parent's log — no network,
 * no tokens, no side effects — and everything from the fork point onward
 * executes for real. That is the whole feature: changing a prompt at step 7 of
 * a twelve-step run costs six steps less than starting over.
 */
export async function fork(parentRunId: string, options: ForkOptions): Promise<RunResult> {
  return reenter(parentRunId, options, {});
}

/**
 * The shared body of `fork`, `replay` and `resume`. They differ in how much of
 * the parent's log they preload and in what they say about themselves in the
 * new run's `run.started` event; the mechanism underneath is one function,
 * which is the same reason replay is not a second code path.
 */
async function reenter(
  parentRunId: string,
  options: ReenterOptions & { atStep?: number; atEffect?: string },
  origin: Partial<ForkOrigin>,
  retryFinalFailure = false,
): Promise<RunResult> {
  const store = options.store ?? new RunStore();
  const parent = store.read(parentRunId);
  const started = parent.find((e) => e.type === "run.started");
  if (!started || started.type !== "run.started") {
    throw new Error(`cannot fork "${parentRunId}": its log has no run.started event`);
  }

  const overrides = options.overrides ?? {};
  const inheritable = inherited(effectsOf(parent));
  const recorded = applyOverrides(
    retryFinalFailure ? withoutFinalFailure(inheritable) : inheritable,
    overrides,
  );
  const cut = forkCut(recorded, options);
  const keyed = deterministicEntries(recorded);
  refuseInertOverrides(overrides, recorded, cut.entries, keyed);

  const agent: AgentSpec = { ...started.agent, ...options.agent };

  return run(options.input ?? started.input, {
    agent,
    provider: options.provider,
    tools: options.tools ?? [],
    budget: options.budget ?? started.budget,
    store,
    runId: options.runId ?? newRunId("fork"),
    journal: new Journal(cut.entries, options.onDivergence ?? "strict", keyed),
    forkedFrom: {
      runId: parentRunId,
      ...cut.origin,
      ...(Object.keys(overrides).length > 0 ? { overrides: Object.keys(overrides).sort() } : {}),
      ...origin,
    },
    ...(options.allowIrreversible ? { allowIrreversible: true } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onStream ? { onStream: options.onStream } : {}),
  });
}

/**
 * How much of the parent's log this run preloads, and how it says so.
 *
 * The two fork points are the same boundary named two ways, so they collapse to
 * one prefix here — and to one description in the log, where `atStep` is always
 * the step execution went live in and `atEffect` narrows it to the effect
 * within that step when the caller asked for one. A reader that knows nothing
 * about effect fork points still learns something true from `atStep` alone.
 *
 * Exported because `planFork` describes this cut without making it, and a plan
 * that cut the log anywhere but where the fork will is a plan of a different
 * run.
 */
export function forkCut(
  recorded: readonly RecordedEffect[],
  options: { atStep?: number; atEffect?: string },
): { entries: JournalEntry[]; origin: Pick<ForkOrigin, "atStep" | "atEffect"> } {
  if (options.atEffect !== undefined) {
    const at = forkPointOf(recorded, options.atEffect);
    return {
      entries: journalUpToEffect(recorded, at.index),
      origin: { atStep: at.step, atEffect: at.key },
    };
  }
  const atStep = options.atStep ?? Number.POSITIVE_INFINITY;
  return Number.isFinite(atStep)
    ? { entries: journalUpToStep(recorded, atStep), origin: { atStep } }
    : { entries: recorded.map(entryOf), origin: { atStep: "all" } };
}

/**
 * A parent's effects as raw material for this run.
 *
 * `overridden` records that a run was told to serve a value its own parent
 * never recorded. Fork that run and the value is inherited like any other
 * recorded value — but not the instruction, which was given to somebody else.
 * Carrying the mark down would have every descendant claiming a substitution it
 * was never asked for; the substitution stays on record in the log where it was
 * made, and `verify`'s lineage check is what finds it from further down.
 */
function inherited(effects: readonly RecordedEffect[]): RecordedEffect[] {
  return effects.map(({ overridden, ...effect }) => effect);
}

/**
 * Drop the throw a run ended on, so a resume retries the call rather than
 * replaying the failure.
 *
 * A recorded failure is an outcome, and everything that reproduces a log serves
 * it back — that is what makes a run that died on a 529 replayable at all. But
 * resuming is the opposite intent: the call that killed the run is precisely
 * the one you came back to make. Execution goes live at the effect the log ends
 * on, and here the log ends on a failure, so that failure is the effect it goes
 * live at. Only the last one — a throw ends the run, so there is never another.
 */
function withoutFinalFailure(effects: readonly RecordedEffect[]): RecordedEffect[] {
  return effects.at(-1)?.failed === undefined ? [...effects] : effects.slice(0, -1);
}

/**
 * An override below the fork point replaces a value the run would have read;
 * one at or above it replaces nothing, because those steps consult the world
 * rather than the log. Silently doing nothing is the worst outcome for a
 * counterfactual — you would read the result as an answer — so it is an error
 * that says which step to fork at instead.
 */
function refuseInertOverrides(
  overrides: Overrides,
  recorded: readonly RecordedEffect[],
  entries: readonly JournalEntry[],
  keyed: readonly JournalEntry[],
): void {
  const served = new Set([...entries, ...keyed].map((e) => e.key));
  for (const key of Object.keys(overrides)) {
    if (served.has(key)) continue;
    // `applyOverrides` has already refused a key this log does not record.
    const step = recorded.find((e) => e.key === key)!.step;
    throw new Error(
      `override "${key}" is at step ${step}, which this fork runs live — the log is ` +
        `not consulted there, so nothing would be served in its place. Fork at step ` +
        `${step + 1} or later to replace it.`,
    );
  }
}

export type ReplayOptions = Omit<ReenterOptions, "agent" | "input">;

/**
 * Re-execute a run entirely from its log. Nothing reaches the network, and the
 * result should match the original event for event — if it doesn't, the loop is
 * reading state the journal doesn't cover, and that's a bug worth finding.
 */
export async function replay(parentRunId: string, options: ReplayOptions): Promise<RunResult> {
  return fork(parentRunId, {
    ...options,
    atStep: Number.POSITIVE_INFINITY,
    runId: options.runId ?? newRunId("replay"),
    onDivergence: options.onDivergence ?? "strict",
  });
}

/** Everything a fork takes except the fork point: a resume replays all of it. */
export type ResumeOptions = ReenterOptions;

/**
 * Carry on a run that stopped early — a crash, a kill, a limit it hit.
 *
 * The whole log is preloaded, so every step the parent got through comes back
 * for free, and execution goes live at the exact effect the log ends on. A
 * process killed between two tool calls picks up at the second one.
 *
 * This is a replay that is allowed to run off the end of its log, and the
 * difference between the two is only intent: `replay` reports the divergence
 * when a run does not reproduce, `resume` expects to reach the end and keep
 * going. That intent decides one other thing. A run the model threw on ends its
 * log with the throw, and a replay serves it back; a resume drops it and makes
 * the call again, because retrying it is the reason you came back. A run that
 * ended with an answer has nothing to carry on from, so it is
 * refused rather than quietly re-run — the recorded prefix would replay to the
 * same answer and the new log would be a duplicate that looked like progress.
 */
export async function resume(parentRunId: string, options: ResumeOptions): Promise<RunResult> {
  const store = options.store ?? new RunStore();
  const events = store.read(parentRunId);
  const parent = summarize(parentRunId, events);

  if (parent.status === "completed" || parent.status === "refused") {
    throw new Error(
      `run "${parentRunId}" ended ${parent.status}, so there is nothing left of it to run. ` +
        `Use "replay" to re-run it from its log, or "fork" with an earlier step to re-run part ` +
        `of it live.`,
    );
  }

  return reenter(
    parentRunId,
    {
      ...options,
      store,
      atStep: Number.POSITIVE_INFINITY,
      runId: options.runId ?? newRunId("resume"),
      onDivergence: options.onDivergence ?? "strict",
    },
    { resumed: { after: effectsOf(events).length, parentStatus: parent.status } },
    true,
  );
}
