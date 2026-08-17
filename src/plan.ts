import { orderFacets, toolKey, type ToolUse } from "./agent.ts";
import { applyOverrides, movedFacets, type Overrides, type RecordedEffect } from "./journal.ts";
import { rebuildRequests, stampOf } from "./rebuild.ts";
import { effectsOf, forkCut, summarize, type ForkPoint } from "./replay.ts";
import { RunStore } from "./store.ts";
import type {
  AgentSpec,
  ModelResponse,
  RetraceEvent,
  RunStatus,
  Tool,
  ToolSchema,
} from "./types.ts";

/** A replayed call this fork would be handed an answer to an older question at. */
export interface PlannedStaleness {
  kind: "model" | "tool";
  step: number;
  key: string;
  /** Which components of the question moved. Empty when the log predates facets. */
  facets: string[];
}

/** A recorded tool call this fork would make again, for real. */
export interface PlannedCall {
  step: number;
  key: string;
  tool: string;
  /** True when the tool as it stands today says it cannot be repeated. */
  irreversible: boolean;
}

/**
 * What a fork would do, read off the log before any of it is paid for.
 *
 * Everything here is a prediction, and every prediction is derived the way the
 * run will derive it: the same cut, the same request digests, the same
 * irreversible check. Nothing executes.
 */
export interface ForkPlan {
  /** The run this would fork. */
  runId: string;
  status: RunStatus;
  /** The spec the fork would run with: the recorded one with the module's fields over it. */
  agent: AgentSpec;
  /** The step execution goes live in, and the call within it when one was named. */
  atStep: number;
  atEffect?: string;
  /** Effects in the parent's log. */
  recorded: number;
  /** How many of them would come out of the log instead of executing. */
  replayed: number;
  /** How many steps that covers whole. */
  replayedSteps: number;
  /** What the replayed prefix would not spend again, and what the parent cost at list price. */
  savedUsd: number;
  costUsd: number;
  /** Replayed calls that would answer a request this fork no longer builds. */
  stale: PlannedStaleness[];
  /** Prefix calls carrying no digest, so there was nothing to compare them against. */
  undigested: number;
  /** Tools the log says the run declared that the ones given here do not. */
  undeclared: string[];
  /**
   * Recorded tool calls this fork would execute for real. Only ever the tail of
   * the fork point's own step: past that the model has not been asked yet, and
   * what it will ask for is the one thing a log cannot say.
   */
  live: PlannedCall[];
  /** The ones of those a tool marks irreversible, which the fork stops at rather than making. */
  held: PlannedCall[];
  /** Set when the staleness could not be predicted, and why. */
  blocked?: string;
}

export type PlanOptions = ForkPoint & {
  /**
   * The tools the fork would declare. Absent is not the same as empty: without
   * them there is no request to rebuild, so the staleness comes back unpredicted
   * rather than guessed at, exactly as `verify`'s `requests` check does.
   */
  tools?: readonly Tool[];
  agent?: Partial<AgentSpec>;
  input?: string;
  overrides?: Overrides;
  /** Report the irreversible calls in the live tail as ones the fork would make. */
  allowIrreversible?: boolean;
  store?: RunStore;
};

/**
 * Say what a fork would replay, save, and go stale on — without running it.
 *
 * A fork's two costs land at different times. The money is obvious and arrives
 * at the end; the one that hurts arrives at the start and is invisible, because
 * the way you find out that the module you passed does not declare the tools the
 * run was recorded with is that the fork runs, pays for a live step, and *then*
 * reports `stale (tools)`. Every ingredient of that answer is in the log and in
 * the module before anything executes.
 *
 * So this cuts the log where the fork will cut it, rebuilds the requests the
 * replayed prefix would be answering — from this run's own effects, the way
 * `verify` does — and compares them against the digests recorded beside the
 * answers. What comes out is the `stale` line the fork would print, ahead of the
 * fork, plus the arithmetic of the free prefix and the one call the fork would
 * refuse to make twice.
 */
export function planFork(parentRunId: string, options: PlanOptions): ForkPlan {
  const store = options.store ?? new RunStore();
  return planForkEvents(parentRunId, store.read(parentRunId), options);
}

/** The same plan, from events already in hand. Reads no store and executes nothing. */
export function planForkEvents(
  runId: string,
  events: readonly RetraceEvent[],
  options: PlanOptions,
): ForkPlan {
  const summary = summarize(runId, events);
  const started = events.find((e) => e.type === "run.started");
  const declared = started?.type === "run.started" ? started.tools : undefined;

  const agent: AgentSpec = { ...summary.agent, ...options.agent };
  const byName = new Map((options.tools ?? []).map((t) => [t.name, t]));
  const recorded = applyOverrides(effectsOf(events), options.overrides ?? {});

  const cut = forkCut(recorded, options);
  const prefix = new Set(cut.entries.map((e) => e.key));
  const replayed = recorded.filter((e) => prefix.has(e.key));

  const live = liveTail(recorded, cut.origin.atEffect, byName);
  const held = options.allowIrreversible === true ? [] : live.filter((c) => c.irreversible);
  const predicted = predictStale(events, recorded, prefix, agent, options);

  return {
    runId,
    status: summary.status,
    agent,
    atStep: cut.origin.atStep === "all" ? summary.steps : cut.origin.atStep,
    ...(cut.origin.atEffect === undefined ? {} : { atEffect: cut.origin.atEffect }),
    recorded: recorded.length,
    replayed: replayed.length,
    replayedSteps: wholeSteps(recorded, prefix),
    savedUsd: chargesUnder(events, prefix),
    costUsd: chargesUnder(events),
    ...predicted,
    // Nothing to hold the log's declarations against when no tools were given.
    // Empty for that reason says something different from empty because the
    // module declares every tool the run did, and the plan says which it means.
    undeclared:
      options.tools === undefined
        ? []
        : (declared ?? []).map((t) => t.name).filter((name) => !byName.has(name)),
    live,
    held,
  };
}

/** Every facet that moved anywhere in the plan, in the order every surface prints them. */
export function plannedStaleFacets(plan: ForkPlan): string[] {
  return orderFacets(plan.stale.flatMap((s) => s.facets));
}

/**
 * The `stale` markings the fork's replayed prefix would carry.
 *
 * The loop below a fork point builds each request out of the agent spec, the
 * declared tools and the conversation the replayed answers themselves make — so
 * the request is knowable without asking anything, and `rebuildRequests` is
 * already the function that knows it. It reads the agent and the tools off the
 * log, which is exactly the pair a fork replaces, so what it is given here is
 * the log as the fork's loop would read it.
 */
function predictStale(
  events: readonly RetraceEvent[],
  recorded: readonly RecordedEffect[],
  prefix: ReadonlySet<string>,
  agent: AgentSpec,
  options: PlanOptions,
): Pick<ForkPlan, "stale" | "undigested" | "blocked"> {
  if (options.tools === undefined) {
    return {
      stale: [],
      undigested: 0,
      blocked:
        "no tools were given, so the requests this fork would build are not knowable — pass the ones its module exports",
    };
  }

  const schemas: ToolSchema[] = options.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const rebuilt = rebuildRequests(asForked(events, recorded, agent, schemas, options.input));
  if (rebuilt.blocked !== undefined) return { stale: [], undigested: 0, blocked: rebuilt.blocked };

  const stale: PlannedStaleness[] = [];
  let undigested = 0;
  const reached = new Set<string>();
  for (const call of rebuilt.calls) {
    const { effect } = call;
    if (!prefix.has(effect.key)) continue;
    reached.add(effect.key);
    // A log written before the digests existed is reported unpredicted rather
    // than guessed at, the same way `verify` reports it unchecked.
    if (effect.requestHash === undefined) {
      undigested++;
      continue;
    }
    const stamp = stampOf(call);
    if (stamp.hash === effect.requestHash) continue;
    stale.push({
      kind: call.kind,
      step: effect.step,
      key: effect.key,
      facets: orderFacets(movedFacets(effect.requestFacets, stamp.facets)),
    });
  }

  // A prefix call the walk never arrived at is a log whose own effects do not
  // ask for everything in it. That is a finding about the log rather than about
  // the fork, and `verify` is the command that reports it as one — so the plan
  // says which calls it could not place and stops short of predicting for them.
  const unreached = recorded
    .filter((e) => e.kind === "model" || e.kind === "tool")
    .filter((e) => prefix.has(e.key) && !reached.has(e.key))
    .map((e) => `"${e.key}"`);
  return {
    stale,
    undigested,
    ...(unreached.length === 0
      ? {}
      : {
          blocked:
            `nothing in this log asks for ${unreached.join(", ")}, so what the prefix ` +
            `would be answering cannot be rebuilt — "retrace verify" is the command for that`,
        }),
  };
}

/**
 * The log as the fork's loop would read it: this module's agent and tools in
 * place of the recorded ones, and any value the fork was told to substitute
 * already substituted, since a replaced answer changes the conversation every
 * later step is recorded against.
 */
function asForked(
  events: readonly RetraceEvent[],
  recorded: readonly RecordedEffect[],
  agent: AgentSpec,
  tools: ToolSchema[],
  input: string | undefined,
): RetraceEvent[] {
  const byKey = new Map(recorded.map((e) => [e.key, e]));
  return events.map((event) => {
    if (event.type === "run.started") {
      return { ...event, agent, tools, ...(input === undefined ? {} : { input }) };
    }
    if (event.type !== "effect") return event;
    const substituted = byKey.get(event.key);
    if (substituted === undefined) return event;
    const { failed: _recorded, ...rest } = event;
    return {
      ...rest,
      value: substituted.value,
      ...(substituted.failed === undefined ? {} : { failed: substituted.failed }),
    };
  });
}

/**
 * The recorded calls a fork would execute for real.
 *
 * Only one step's worth is ever knowable, and only when the fork point is inside
 * a step: forking at `step:2#1:search` keeps the model turn that asked, so the
 * calls it asked for after that one are exactly what will run. Fork at a step and
 * the model is asked again — what it says next is the whole reason you forked
 * there, and nothing in the log predicts it.
 */
function liveTail(
  recorded: readonly RecordedEffect[],
  atEffect: string | undefined,
  tools: ReadonlyMap<string, Tool>,
): PlannedCall[] {
  if (atEffect === undefined) return [];
  const at = recorded.find((e) => e.key === atEffect);
  if (at === undefined || at.kind !== "tool") return [];

  const turn = recorded.find((e) => e.kind === "model" && e.step === at.step);
  if (turn === undefined || turn.failed !== undefined) return [];
  const asked = (turn.value as ModelResponse).content.filter(
    (b): b is ToolUse => b.type === "tool_use",
  );

  const from = asked.findIndex((call, i) => toolKey(at.step, i, call.name) === at.key);
  if (from === -1) return [];
  return asked.slice(from).map((call, i) => ({
    step: at.step,
    key: toolKey(at.step, from + i, call.name),
    tool: call.name,
    irreversible: tools.get(call.name)?.irreversible === true,
  }));
}

/** Steps every one of whose effects comes out of the log. */
function wholeSteps(recorded: readonly RecordedEffect[], prefix: ReadonlySet<string>): number {
  const partial = new Set(recorded.filter((e) => !prefix.has(e.key)).map((e) => e.step));
  return new Set(recorded.filter((e) => !partial.has(e.step)).map((e) => e.step)).size;
}

/**
 * What the log was charged at list price, over the steps whose model call is in
 * the prefix — or over all of them when no prefix is given.
 *
 * A replayed model call is billed nothing and still costs what it cost, which is
 * the gap `savedUsd` reports. Reading it off the parent's own charges is what
 * makes the number a prediction rather than an estimate.
 */
function chargesUnder(events: readonly RetraceEvent[], prefix?: ReadonlySet<string>): number {
  return events
    .filter((e) => e.type === "charge")
    .filter((e) => prefix === undefined || prefix.has(`step:${e.step}`))
    .reduce((total, e) => total + e.costUsd, 0);
}
