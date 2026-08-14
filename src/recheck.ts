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
  /** It was asked the recorded question and said something else. */
  | "moved"
  /** The recorded value was substituted by hand, so no tool ever produced it. */
  | "substituted"
  /** The module exports no tool by that name. */
  | "missing"
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
  /** Milliseconds this execution took. Zero when nothing ran. */
  durationMs: number;
}

export interface RecheckReport {
  runId: string;
  /** False when a tool no longer returns what the log holds. */
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
 * It executes real tools, which is the same hazard as forking past a
 * `send_email` — the recorded call runs again, for real. `only` is how you keep
 * it to the ones that just read.
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
  const journal = new Journal([], "strict", deterministicEntries(effectsOf(events)));

  const calls: RecheckedCall[] = [];
  for (const recorded of recordedToolCalls(events)) {
    calls.push(await recheckOne(recorded, byName, wanted, journal));
  }

  return {
    runId,
    ok: !calls.some((c) => c.status === "moved"),
    complete: calls.every((c) => c.status === "same" || c.status === "moved"),
    calls,
  };
}

async function recheckOne(
  recorded: RecordedToolCall,
  tools: ReadonlyMap<string, Tool>,
  wanted: ReadonlySet<string> | undefined,
  journal: Journal,
): Promise<RecheckedCall> {
  const { step, key, call, value } = recorded;
  const base = { step, key, tool: call.name, input: call.input, recorded: value, durationMs: 0 };

  // A substituted value is an answer somebody made up, so a tool disagreeing
  // with it is the tool doing its job. There is nothing here to hold it to.
  if (recorded.overridden) return { ...base, status: "substituted" };
  if (wanted !== undefined && !wanted.has(call.name)) return { ...base, status: "skipped" };
  if (!tools.has(call.name)) return { ...base, status: "missing" };

  const startedAt = Date.now();
  const now = await invoke(tools, call, recordedContext(journal, step, key));
  return {
    ...base,
    status: now.content === value.content && now.isError === value.isError ? "same" : "moved",
    now,
    durationMs: Date.now() - startedAt,
  };
}

/** A recorded call, paired with the question the model put to it. */
interface RecordedToolCall {
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
 */
function recordedToolCalls(events: readonly RetraceEvent[]): RecordedToolCall[] {
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
