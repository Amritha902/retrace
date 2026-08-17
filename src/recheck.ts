import { invoke, recordedContext, toolKey, type ToolUse } from "./agent.ts";
import { deterministicEntries, Journal } from "./journal.ts";
import { effectsOf } from "./replay.ts";
import { RunStore } from "./store.ts";
import type { ModelResponse, RetraceEvent, Tool } from "./types.ts";

/** A tool's answer, exactly as the log holds it. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export type RecheckStatus =
  /** The tool was asked the recorded question and gave the recorded answer. */
  | "same"
  /** It was asked the recorded question and twice said the same something else. */
  | "moved"
  /** It did not say the same thing twice, so it never had an answer to hold it to. */
  | "unstable"
  /** The recorded value was substituted by hand, so no tool ever produced it. */
  | "substituted"
  /** The module exports no tool by that name. */
  | "missing"
  /** Marked `irreversible`, so it was held back rather than done a second time. */
  | "irreversible"
  /** Narrowed out by `only`. */
  | "skipped";

export interface RecheckedCall {
  step: number;
  /** The effect key, exactly as `show` prints it. */
  key: string;
  tool: string;
  /** What the model asked for, recovered from the response that asked for it. */
  input: unknown;
  status: RecheckStatus;
  /** What the log holds for this call. */
  recorded: ToolOutcome;
  /** What the tool said just now. Absent unless it executed. */
  now?: ToolOutcome;
  /**
   * What it said when asked a second time. Present only on a call that
   * disagreed with the log the first time, which is the only case a second
   * execution can settle anything — see `recheckOne`.
   */
  again?: ToolOutcome;
  /**
   * Milliseconds spent executing this call — both times, where it was asked
   * twice. Zero when nothing ran.
   */
  durationMs: number;
}

/**
 * Whether this call actually ran, and so counts towards what was compared.
 * Every surface that reports a proportion counts with this, rather than
 * re-listing the statuses and coming to disagree with `complete`.
 */
export function executed(call: RecheckedCall): boolean {
  return call.status === "same" || call.status === "moved" || call.status === "unstable";
}

export interface RecheckReport {
  runId: string;
  /** False when a tool no longer returns what the log holds, or never settled on one. */
  ok: boolean;
  /** True when every recorded call was executed and compared. */
  complete: boolean;
  calls: RecheckedCall[];
}

export interface RecheckOptions {
  /** The tools as they are today. Anything a call names and this omits is `missing`. */
  tools?: readonly Tool[];
  store?: RunStore;
  /**
   * Execute only these tools; every other call comes back `skipped`. The way to
   * re-check a run whose tool list includes one you do not want run twice.
   */
  only?: readonly string[];
  /**
   * Execute tools marked `irreversible` too. Off by default: this command runs
   * recorded calls again for real, and a tool that declares it cannot be
   * repeated has already answered the question of whether it should be.
   */
  allowIrreversible?: boolean;
}

/**
 * Ask the tools whether the log is still true.
 *
 * Everything else in this runtime reads a log. `verify` proves a fork's free
 * prefix is the prefix its parent recorded, and the request digests prove a
 * replayed call was asked what it was recorded being asked — but none of that
 * can say whether the recorded *answer* is still the answer. A prefix is only
 * worth replaying if the world underneath it has not moved, and the only way to
 * find that out is to ask the world.
 *
 * So this re-executes each recorded tool call with the input the model supplied
 * at the time and compares what comes back against what the log holds. The model
 * is never called: the questions are already in the log, and re-deriving them
 * would just be a second run.
 *
 * A call that disagrees is then asked once more, which is the difference between
 * "the world moved" and "this tool never had an answer to record" — see
 * `recheckOne`. A call that agreed is asked once and no more.
 *
 * It executes real tools, which is the same hazard as forking past a
 * `send_email` — the recorded call runs again, for real, and a disagreeing one
 * runs twice. A tool marked `irreversible` is held back for that reason and
 * reported rather than run; `only` narrows the rest to the ones that just read.
 */
export async function recheckRun(
  runId: string,
  options: RecheckOptions = {},
): Promise<RecheckReport> {
  const store = options.store ?? new RunStore();
  return recheckEvents(runId, store.read(runId), options);
}

/** The same, from events already in hand. */
export async function recheckEvents(
  runId: string,
  events: readonly RetraceEvent[],
  options: RecheckOptions = {},
): Promise<RecheckReport> {
  const byName = new Map((options.tools ?? []).map((t) => [t.name, t]));
  const wanted = options.only === undefined ? undefined : new Set(options.only);

  // Reads resolve to what the run recorded at the same slots, so a tool that
  // puts a timestamp or an id in its answer is compared on the rest of it.
  //
  // Every read but one. A recorded `ctx.fetch` is served to a fork, on purpose —
  // a fork should differ from its parent in the thing you changed and nothing
  // else — but serving it here would answer the question this command exists to
  // ask. Whether the world still says what the log holds is exactly what a
  // network read decides, so those go live and the rest stay pinned, which
  // leaves the network as the only thing that can have moved.
  const reads = deterministicEntries(effectsOf(events)).filter((e) => e.kind !== "fetch");
  const journal = new Journal([], "strict", reads);

  const calls: RecheckedCall[] = [];
  for (const recorded of recordedToolCalls(events)) {
    calls.push(
      await recheckOne(recorded, byName, wanted, journal, options.allowIrreversible === true),
    );
  }

  return {
    runId,
    ok: !calls.some((c) => c.status === "moved" || c.status === "unstable"),
    complete: calls.every(executed),
    calls,
  };
}

async function recheckOne(
  recorded: RecordedToolCall,
  tools: ReadonlyMap<string, Tool>,
  wanted: ReadonlySet<string> | undefined,
  journal: Journal,
  allowIrreversible: boolean,
): Promise<RecheckedCall> {
  const { step, key, call, value } = recorded;
  const base = { step, key, tool: call.name, input: call.input, recorded: value, durationMs: 0 };

  // A substituted value is an answer somebody made up, so a tool disagreeing
  // with it is the tool doing its job. There is nothing here to hold it to.
  if (recorded.overridden) return { ...base, status: "substituted" };
  if (wanted !== undefined && !wanted.has(call.name)) return { ...base, status: "skipped" };
  const tool = tools.get(call.name);
  if (tool === undefined) return { ...base, status: "missing" };
  // Naming it with `only` is not consent to run it: this command's whole job is
  // to execute recorded calls a second time, and the tool has already said that
  // is the one thing it cannot survive. `allowIrreversible` is the consent.
  if (tool.irreversible && !allowIrreversible) return { ...base, status: "irreversible" };

  const startedAt = Date.now();
  const now = await invoke(tools, call, recordedContext(journal, step, key));
  if (agree(now, value)) return { ...base, status: "same", now, durationMs: Date.now() - startedAt };

  // It disagreed, and the obvious reading — a stable tool whose corpus moved
  // underneath the log — is only one of the two things that produce this. The
  // other is a tool with no settled answer at all: one that reads the clock or
  // an id from outside `ctx`, where the journal cannot follow it. Both look
  // identical against the log, and they mean opposite things. A replayed
  // prefix off a moved tool is stale; off an unstable one it was never an
  // answer, and re-recording the run would not fix it.
  //
  // Asking a second time is what separates them, because the recorded reads
  // resolve by key: a tool taking its timestamps from `ctx` gets the same ones
  // both times and can only differ if it went somewhere the journal is not.
  const again = await invoke(tools, call, recordedContext(journal, step, key));
  return {
    ...base,
    status: agree(again, now) ? "moved" : "unstable",
    now,
    again,
    durationMs: Date.now() - startedAt,
  };
}

/** Two answers are the same answer when the model could not tell them apart. */
function agree(a: ToolOutcome, b: ToolOutcome): boolean {
  return a.content === b.content && a.isError === b.isError;
}

/** A recorded call, paired with the question the model put to it. */
export interface RecordedToolCall {
  step: number;
  key: string;
  call: ToolUse;
  value: ToolOutcome;
  overridden: boolean;
}

/**
 * The tool calls a log records, each with the input it was made with.
 *
 * The input is not in the tool's own effect — only a digest of it is — so it
 * comes off the model response that asked for the call, matched to the effect
 * by the key the loop builds from the same two numbers. Reconstructing it the
 * loop's way, with the loop's own `toolKey`, is what stops the two drifting.
 *
 * Exported because `explainStale` needs the same question for a different
 * reason — to say what a replayed call was asked that this run no longer asks —
 * and there is only one right way to read it back out.
 */
export function recordedToolCalls(events: readonly RetraceEvent[]): RecordedToolCall[] {
  const effects = effectsOf(events);
  const byKey = new Map(effects.filter((e) => e.kind === "tool").map((e) => [e.key, e]));

  const calls: RecordedToolCall[] = [];
  for (const effect of effects) {
    // A call that threw asked for nothing, so there is nothing to re-check.
    if (effect.kind !== "model" || effect.failed) continue;
    const asked = (effect.value as ModelResponse).content.filter(
      (b): b is ToolUse => b.type === "tool_use",
    );
    for (const [ordinal, call] of asked.entries()) {
      const recorded = byKey.get(toolKey(effect.step, ordinal, call.name));
      // A run killed between a model response and the call it asked for leaves
      // the question in the log and the answer nowhere. Nothing to compare.
      if (recorded === undefined) continue;
      calls.push({
        step: effect.step,
        key: recorded.key,
        call,
        value: recorded.value as ToolOutcome,
        overridden: recorded.overridden === true,
      });
    }
  }
  return calls;
}
