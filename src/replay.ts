import { run, type RunOptions } from "./agent.ts";
import {
  deterministicEntries,
  Journal,
  journalUpToStep,
  type DivergencePolicy,
  type JournalEntry,
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
  const events = store.read(runId);
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

  const recorded = effectsOf(parent);
  const entries: JournalEntry[] = Number.isFinite(options.atStep)
    ? journalUpToStep(recorded, options.atStep)
    : recorded.map((e, i) => ({ index: i, kind: e.kind, key: e.key, value: e.value }));

  const agent: AgentSpec = { ...started.agent, ...options.agent };

  return run(options.input ?? started.input, {
    agent,
    provider: options.provider,
    tools: options.tools ?? [],
    budget: options.budget ?? started.budget,
    store,
    runId: options.runId ?? newRunId("fork"),
    journal: new Journal(
      entries,
      options.onDivergence ?? "strict",
      deterministicEntries(recorded),
    ),
    forkedFrom: {
      runId: parentRunId,
      atStep: Number.isFinite(options.atStep) ? options.atStep : "all",
    },
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
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
