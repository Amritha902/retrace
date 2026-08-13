import { run, type RunOptions } from "./agent.ts";
import {
  applyOverrides,
  deterministicEntries,
  entryOf,
  Journal,
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

/** The effects a run served from a log after being told to change their value. */
export function overriddenEffects(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => e.overridden === true);
}

export interface ForkOptions {
  provider: Provider;
  /**
   * Steps below this index are served from the parent's log. Step `atStep` is
   * the first one that runs live, so `atStep: 0` is a fresh run with the
   * parent's configuration and `atStep: Infinity` is a full replay.
   */
  atStep: number;
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
  onEvent?: RunOptions["onEvent"];
  /**
   * Fragments of each assistant turn. Steps served from the log deliver theirs
   * reconstructed and flagged `replayed`, so a fork renders the same way above
   * and below its fork point.
   */
  onStream?: RunOptions["onStream"];
}

/**
 * Re-run a recorded run with something changed.
 *
 * The prefix below `atStep` comes out of the parent's log — no network, no
 * tokens, no side effects — and everything from `atStep` onward executes for
 * real. That is the whole feature: changing a prompt at step 7 of a twelve-step
 * run costs six steps less than starting over.
 */
export async function fork(parentRunId: string, options: ForkOptions): Promise<RunResult> {
  const store = options.store ?? new RunStore();
  const parent = store.read(parentRunId);
  const started = parent.find((e) => e.type === "run.started");
  if (!started || started.type !== "run.started") {
    throw new Error(`cannot fork "${parentRunId}": its log has no run.started event`);
  }

  const overrides = options.overrides ?? {};
  const recorded = applyOverrides(effectsOf(parent), overrides);
  const entries: JournalEntry[] = Number.isFinite(options.atStep)
    ? journalUpToStep(recorded, options.atStep)
    : recorded.map(entryOf);
  const keyed = deterministicEntries(recorded);
  refuseInertOverrides(overrides, recorded, entries, keyed, options.atStep);

  const agent: AgentSpec = { ...started.agent, ...options.agent };

  return run(options.input ?? started.input, {
    agent,
    provider: options.provider,
    tools: options.tools ?? [],
    budget: options.budget ?? started.budget,
    store,
    runId: options.runId ?? newRunId("fork"),
    journal: new Journal(entries, options.onDivergence ?? "strict", keyed),
    forkedFrom: {
      runId: parentRunId,
      atStep: Number.isFinite(options.atStep) ? options.atStep : "all",
      ...(Object.keys(overrides).length > 0 ? { overrides: Object.keys(overrides).sort() } : {}),
    },
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onStream ? { onStream: options.onStream } : {}),
  });
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
  atStep: number,
): void {
  const served = new Set([...entries, ...keyed].map((e) => e.key));
  for (const key of Object.keys(overrides)) {
    if (served.has(key)) continue;
    const step = recorded.find((e) => e.key === key)?.step ?? atStep;
    throw new Error(
      `override "${key}" is at step ${step}, which this fork runs live — the log is ` +
        `not consulted there, so nothing would be served in its place. Fork at step ` +
        `${step + 1} or later to replace it.`,
    );
  }
}

export type ReplayOptions = Omit<ForkOptions, "atStep" | "agent" | "input">;

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
