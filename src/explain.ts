import { orderFacets, REQUEST_FACETS, TOOL_FACETS } from "./agent.ts";
import { recordedToolCalls } from "./recheck.ts";
import { staleEffects } from "./replay.ts";
import { RunStore } from "./store.ts";
import type { AgentSpec, Message, RetraceEvent, ToolSchema } from "./types.ts";

type Effect = Extract<RetraceEvent, { type: "effect" }>;
type Started = Extract<RetraceEvent, { type: "run.started" }>;

/** One thing that moved, and every replayed effect it accounts for. */
export interface StaleChange {
  /** `system`, `tools`, `conversation`, `input` — the name `show` prints. */
  facet: string;
  /** Which part of the facet moved, where a facet has parts. */
  where?: string;
  /** The effect keys this change explains, in log order. */
  keys: string[];
  /** What the parent recorded the effect against. */
  before: string;
  /** What this run builds in its place. */
  after: string;
}

/** A facet that moved and the logs cannot account for, and why not. */
export interface UnexplainedStaleness {
  facet: string;
  keys: string[];
  why: string;
}

export interface StaleReport {
  runId: string;
  /** The run this one replayed from, when it replayed from one. */
  parentRunId?: string;
  /** How many effects came out of the log against a request this run no longer builds. */
  staleEffects: number;
  changes: StaleChange[];
  unexplained: UnexplainedStaleness[];
  /** True when every facet of every stale effect is accounted for. */
  complete: boolean;
}

/**
 * The facets this build can say something about. `test/explain.test.ts` holds it
 * to the facets the loop actually writes, so a component added to a request
 * without an explanation here is a test failure rather than a silent `?`.
 */
export const EXPLAINED_FACETS: readonly string[] = [...REQUEST_FACETS, ...TOOL_FACETS];

const NO_SYSTEM = "(no system prompt)";
const UNSET = "(unset)";
const NOT_DECLARED = "(not declared)";
const NO_MESSAGE = "(no message)";

/**
 * Say what moved under a run's replayed prefix.
 *
 * `stale` is a mark on an effect: served from the log, and recorded against a
 * request this run no longer builds. `staleFacets` narrows that to a component —
 * `system`, `tools`, `conversation`. Neither can say what the component moved
 * *to*, because what the log keeps of a request is a digest, and a digest is a
 * one-way street.
 *
 * The way out is that the other side of the comparison is not lost: it is in the
 * parent's log, which is the same log the free prefix came out of. So this reads
 * both, rebuilds the two requests component by component, and reports the
 * difference the digests could only point at. It executes nothing, reaches
 * nothing, and needs the parent in the store — without it the mark stands and
 * this says so rather than guessing.
 */
export function explainStale(runId: string, store: RunStore = new RunStore()): StaleReport {
  const events = store.read(runId);
  return explainStaleEvents(runId, events, parentOf(events, store));
}

/**
 * The same, from events already in hand. `parent` is the log this run was forked
 * from; leave it out and every staleness comes back unexplained, which is the
 * true answer for a fork read on a machine that has never seen its parent.
 */
export function explainStaleEvents(
  runId: string,
  events: readonly RetraceEvent[],
  parent?: readonly RetraceEvent[],
): StaleReport {
  const started = startedOf(runId, events);
  const parentRunId = started.forkedFrom?.runId;
  const stale = staleEffects(events);

  // Grouped, because one change explains many effects: rewriting the system
  // prompt of a twelve-step run moves the same component under all twelve, and
  // printing it twelve times would bury the one line worth reading.
  const changes = new Map<string, StaleChange>();
  const unexplained = new Map<string, UnexplainedStaleness>();

  const addChange = (facet: string, moved: Moved, key: string): void => {
    const id = json([facet, moved.where ?? null, moved.before, moved.after]);
    const seen = changes.get(id);
    if (seen) {
      seen.keys.push(key);
      return;
    }
    changes.set(id, {
      facet,
      ...(moved.where === undefined ? {} : { where: moved.where }),
      keys: [key],
      before: moved.before,
      after: moved.after,
    });
  };

  const addUnexplained = (facet: string, why: string, key: string): void => {
    const id = json([facet, why]);
    const seen = unexplained.get(id);
    if (seen) {
      seen.keys.push(key);
      return;
    }
    unexplained.set(id, { facet, keys: [key], why });
  };

  const sides =
    parent === undefined
      ? undefined
      : { before: sideOf(parentRunId ?? "the parent", parent), after: sideOf(runId, events) };

  for (const effect of stale) {
    const facets = effect.staleFacets ?? [];
    if (facets.length === 0) {
      // A log written before per-component digests knows the request moved and
      // not which part of it. Reported as what it is, rather than compared
      // component by component and passed off as what the log said.
      addUnexplained(
        "the request",
        "this log names no component: it was written before the per-component digests, so all it recorded is that the request moved",
        effect.key,
      );
      continue;
    }

    for (const facet of orderFacets(facets)) {
      if (sides === undefined) {
        addUnexplained(
          facet,
          `${parentRunId ?? "the run this one replayed from"} is not in this store, so the request this effect was recorded against is not here to compare — "retrace import" its bundle and this reads whole`,
          effect.key,
        );
        continue;
      }

      const explanation = explainFacet(facet, effect, sides.before, sides.after);
      if ("why" in explanation) {
        addUnexplained(facet, explanation.why, effect.key);
        continue;
      }
      if (explanation.moved.length === 0) {
        // The digest says this component moved and the two logs agree on it.
        // Nothing the loop writes does that, so the honest reading is that one
        // of the logs has been edited under the digest that was taken of it.
        addUnexplained(
          facet,
          "the two logs agree on this component, which the digest recorded as changed — one of them has been edited since it was written",
          effect.key,
        );
        continue;
      }
      for (const moved of explanation.moved) addChange(facet, moved, effect.key);
    }
  }

  return {
    runId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    staleEffects: stale.length,
    changes: byFacet([...changes.values()]),
    unexplained: byFacet([...unexplained.values()]),
    complete: unexplained.size === 0,
  };
}

/** One run's half of the comparison, read out of its log once. */
interface Side {
  runId: string;
  agent: AgentSpec;
  input: string;
  /** Absent on a log written before the tools were recorded. */
  tools?: ToolSchema[];
  events: readonly RetraceEvent[];
  /** The question each recorded tool call was asked, keyed as `show` prints it. */
  toolInputs: Map<string, unknown>;
}

function sideOf(runId: string, events: readonly RetraceEvent[]): Side {
  const started = startedOf(runId, events);
  return {
    runId,
    agent: started.agent,
    input: started.input,
    ...(started.tools === undefined ? {} : { tools: started.tools }),
    events,
    toolInputs: new Map(recordedToolCalls(events).map((c) => [c.key, c.call.input])),
  };
}

/** One difference within a component. */
interface Moved {
  where?: string;
  before: string;
  after: string;
}

/** What moved within one component, or why the logs cannot say. */
type Explanation = { moved: Moved[] } | { why: string };

function explainFacet(facet: string, effect: Effect, before: Side, after: Side): Explanation {
  switch (facet) {
    case "model":
      return one(before.agent.model, after.agent.model);
    case "system":
      return one(before.agent.system ?? NO_SYSTEM, after.agent.system ?? NO_SYSTEM);
    case "settings":
      return settingsMoved(before, after);
    case "tools":
      return toolsMoved(before, after);
    case "conversation":
      return conversationMoved(effect.step, before, after);
    case "input":
      return inputMoved(effect, before, after);
    default:
      // `orderFacets` deliberately keeps a facet this build does not know rather
      // than dropping it, so it can arrive here — from a log a later version
      // wrote. Naming it is more use than pretending it was accounted for.
      return { why: `this build does not know the component "${facet}", so it cannot say what moved in it` };
  }
}

/** The fields the `settings` digest covers, and nothing else — see `requestFacets`. */
const SETTINGS = ["maxTokens", "effort", "thinking"] as const;

function settingsMoved(before: Side, after: Side): Explanation {
  return {
    moved: SETTINGS.filter((key) => show(before.agent[key]) !== show(after.agent[key])).map(
      (key) => ({ where: key, before: show(before.agent[key]), after: show(after.agent[key]) }),
    ),
  };
}

/**
 * Which tools the two runs declared, and how they differ.
 *
 * This is the staleness worth reading. `system` moving on a fork is the fork
 * doing what you asked; `tools` moving beside it is a module that does not
 * declare what the run was recorded with, and until the log carried the
 * declarations there was no way to find out which tool.
 */
function toolsMoved(before: Side, after: Side): Explanation {
  if (before.tools === undefined || after.tools === undefined) {
    const which =
      before.tools === undefined && after.tools === undefined
        ? "neither log records"
        : `${(before.tools === undefined ? before : after).runId} does not record`;
    return {
      why: `${which} the tools its run declared — those logs predate the declaration, so what the model was shown is not there to compare`,
    };
  }

  const b = new Map(before.tools.map((t) => [t.name, t]));
  const a = new Map(after.tools.map((t) => [t.name, t]));
  const moved: Array<{ where?: string; before: string; after: string }> = [];

  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const was = b.get(name);
    const now = a.get(name);
    if (!was || !now) {
      moved.push({
        where: name,
        before: was ? was.description : NOT_DECLARED,
        after: now ? now.description : NOT_DECLARED,
      });
      continue;
    }
    if (was.description !== now.description) {
      moved.push({ where: `${name} · description`, before: was.description, after: now.description });
    }
    if (json(was.inputSchema) !== json(now.inputSchema)) {
      moved.push({
        where: `${name} · inputSchema`,
        before: json(was.inputSchema),
        after: json(now.inputSchema),
      });
    }
  }

  // The digest is of the array, so declaring the same tools in another order
  // moves it with nothing to show per tool. Saying so beats reporting a
  // component that changed and no change.
  if (moved.length === 0) {
    return one(before.tools.map((t) => t.name).join(", "), after.tools.map((t) => t.name).join(", "), "order");
  }
  return { moved };
}

/**
 * The first message the two conversations disagree on.
 *
 * Only the first: everything after it follows from it, and a fork that replaced
 * a tool result at step 0 would otherwise report the same substitution once per
 * message of every step below the fork point.
 */
function conversationMoved(step: number, before: Side, after: Side): Explanation {
  const b = conversationAt(before, step);
  const a = conversationAt(after, step);

  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    const was = b[i];
    const now = a[i];
    if (json(was) === json(now)) continue;
    const shape = describeMessage(was ?? now!);
    const rendered = { before: was ? render(was) : NO_MESSAGE, after: now ? render(now) : NO_MESSAGE };
    // Two messages can render the same and still differ — in a tool_use id, in
    // the `isError` flag. Showing identical lines under a heading that says
    // something moved would be worse than showing the raw shape.
    const shown =
      rendered.before === rendered.after ? { before: json(was), after: json(now) } : rendered;
    return { moved: [{ where: `message ${i} · ${shape}`, ...shown }] };
  }
  return { moved: [] };
}

/**
 * The conversation as it stood when this step's model call was made: the input,
 * then every message the earlier steps appended. Assistant turns are compared
 * without `raw`, exactly as the digest hashes them.
 */
function conversationAt(side: Side, step: number): Message[] {
  const said = side.events
    .filter((e): e is Extract<RetraceEvent, { type: "message" }> => e.type === "message")
    .filter((e) => e.step < step)
    .map((e) => e.message);
  return [
    { role: "user", content: [{ type: "text", text: side.input }] },
    ...said.map((m) => (m.role === "assistant" ? { role: m.role, content: m.content } : m)),
  ];
}

/**
 * What a replayed tool call was asked, in each run.
 *
 * A tool call's input comes out of the model response above it, so this moves
 * only when that response did — an override, or a hand-edited log. It is the
 * case where a replayed result stops being an answer to anything this run asked.
 */
function inputMoved(effect: Effect, before: Side, after: Side): Explanation {
  const was = before.toolInputs.get(effect.key);
  const now = after.toolInputs.get(effect.key);
  if (was === undefined || now === undefined) {
    const which = was === undefined ? before.runId : after.runId;
    return {
      why: `${which} records no model response asking for ${effect.key}, so what the call was asked is not there to compare`,
    };
  }
  return one(json(was), json(now));
}

function one(before: string, after: string, where?: string): Explanation {
  return {
    moved:
      before === after ? [] : [{ ...(where === undefined ? {} : { where }), before, after }],
  };
}

/** `user · tool_result`, `assistant · text/tool_use` — enough to find it by eye. */
function describeMessage(message: Message): string {
  const kinds = [...new Set(message.content.map((b) => b.type))].join("/");
  return `${message.role} · ${kinds}`;
}

function render(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return "(thinking)";
      if (block.type === "tool_use") return `${block.name}(${json(block.input)})`;
      return block.isError ? `error: ${block.content}` : block.content;
    })
    .join(" ")
    .trim();
}

/** Facet order, then the order the effects appear in — see `orderFacets`. */
function byFacet<T extends { facet: string }>(items: T[]): T[] {
  const rank = new Map(orderFacets(items.map((i) => i.facet)).map((f, i) => [f, i]));
  return [...items].sort((a, b) => rank.get(a.facet)! - rank.get(b.facet)!);
}

function parentOf(
  events: readonly RetraceEvent[],
  store: RunStore,
): readonly RetraceEvent[] | undefined {
  const started = events.find((e) => e.type === "run.started");
  const from = started?.type === "run.started" ? started.forkedFrom?.runId : undefined;
  if (from === undefined || !store.exists(from)) return undefined;
  return store.read(from);
}

function startedOf(runId: string, events: readonly RetraceEvent[]): Started {
  const started = events.find((e) => e.type === "run.started");
  if (started?.type !== "run.started") {
    throw new Error(`run "${runId}" has no run.started event — the log is truncated or not a run`);
  }
  return started;
}

function show(value: unknown): string {
  return value === undefined ? UNSET : String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
