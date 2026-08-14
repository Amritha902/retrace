import { toolKey, type ToolUse } from "./agent.ts";
import { effectsOf } from "./replay.ts";
import type {
  Message,
  ModelRequest,
  ModelResponse,
  RetraceEvent,
  UserBlock,
} from "./types.ts";

type Effect = Extract<RetraceEvent, { type: "effect" }>;
type ToolResult = { content: string; isError: boolean };

/**
 * A recorded call, beside the question the rest of the log says it was put.
 *
 * The log holds the answers and a digest of each question, never the question
 * itself — a model request is the conversation so far, and storing it at every
 * step would store the run once per step. It does not have to: the conversation
 * is what the earlier answers build, so the question can be derived.
 */
export type RebuiltCall =
  | { kind: "model"; effect: Effect; request: ModelRequest }
  | { kind: "tool"; effect: Effect; call: ToolUse };

export interface RebuiltRequests {
  /** Every model and tool call the walk reached, in log order. */
  calls: RebuiltCall[];
  /** The messages the loop would have appended, in the order it emitted them. */
  messages: { step: number; message: Message }[];
  /** Set when the log cannot be walked at all, and why. */
  blocked?: string;
  /**
   * Calls the walk never arrived at. A tool result is reached from the model
   * response that asked for it, so an effect nothing reaches is an answer to a
   * call this log does not record anybody making.
   */
  unreached: Effect[];
  /**
   * An effect the walk stopped on because it records no outcome it could read.
   * A model call either came back with a response or threw; one that did neither
   * is a log somebody has been at, and there is no conversation past it.
   */
  outcomeless?: Effect;
}

/**
 * Rebuild every request a log records an answer to, from the log itself.
 *
 * This is the agent loop with the provider and the tools taken out. It starts
 * from the input, replays each recorded model response into an assistant turn,
 * turns each recorded tool result into the message the model was shown next, and
 * assembles the request that stood in front of every call on the way — which is
 * exactly what the loop does, because the loop has nothing else to build a
 * request out of either.
 *
 * What that buys is a question a log could not previously be asked: are its
 * answers answers to its own questions? Every effect carries a digest of what it
 * was asked, so comparing the two says whether a value was edited, spliced in or
 * reordered — with no parent, no store and no network. `verify`'s `requests`
 * check is that comparison; this is the half that does not need to know what a
 * digest is.
 */
export function rebuildRequests(events: readonly RetraceEvent[]): RebuiltRequests {
  const started = events.find((e) => e.type === "run.started");
  if (started?.type !== "run.started") {
    return { calls: [], messages: [], unreached: [], blocked: "the log has no run.started event" };
  }
  // Absent, rather than empty, means a log written before a run recorded what it
  // declared. The tools are part of every request, so without them there is no
  // request to rebuild — and guessing at an empty list would report a whole log
  // as edited.
  if (started.tools === undefined) {
    return {
      calls: [],
      messages: [],
      unreached: [],
      blocked:
        "this log predates the tool declarations a run now records, so the requests it made cannot be rebuilt",
    };
  }

  const { agent, tools, input } = started;
  const effects = effectsOf(events);
  const byKey = new Map(effects.filter((e) => e.kind === "tool").map((e) => [e.key, e]));

  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: input }] }];
  const emitted: { step: number; message: Message }[] = [];
  const calls: RebuiltCall[] = [];
  const reached = new Set<Effect>();
  let outcomeless: Effect | undefined;

  for (const effect of effects) {
    // Tool calls are arrived at through the response that asked for them, which
    // is the only place their input is recorded. Clock, id and random reads are
    // answers to no question and carry no digest.
    if (effect.kind !== "model") continue;

    reached.add(effect);
    calls.push({
      kind: "model",
      effect,
      request: {
        model: agent.model,
        system: agent.system,
        messages: [...messages],
        tools,
        maxTokens: agent.maxTokens,
        effort: agent.effort,
        thinking: agent.thinking,
      },
    });

    // A throw ends the run: there is no response to carry the conversation on.
    if (effect.failed) break;

    const response = effect.value as ModelResponse | null;
    if (response === null) {
      outcomeless = effect;
      break;
    }

    const assistant: Message = {
      role: "assistant",
      content: response.content,
      ...(response.raw === undefined ? {} : { raw: response.raw }),
    };
    messages.push(assistant);
    emitted.push({ step: effect.step, message: assistant });

    if (response.stopReason === "refusal") break;

    const asked = response.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (asked.length === 0) break;

    const results: UserBlock[] = [];
    let whole = true;
    for (const [ordinal, call] of asked.entries()) {
      const recorded = byKey.get(toolKey(effect.step, ordinal, call.name));
      // A run killed between a model response and the call it asked for — or
      // stopped at a budget in the middle of a step — leaves the question in the
      // log and the answer nowhere. The walk ends where the run did.
      if (recorded === undefined) {
        whole = false;
        break;
      }
      reached.add(recorded);
      calls.push({ kind: "tool", effect: recorded, call });
      const value = recorded.value as ToolResult;
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: value.content,
        ...(value.isError ? { isError: true } : {}),
      });
    }
    if (!whole) break;

    const toolMessage: Message = { role: "user", content: results };
    messages.push(toolMessage);
    emitted.push({ step: effect.step, message: toolMessage });
  }

  return {
    calls,
    messages: emitted,
    unreached: effects.filter((e) => (e.kind === "model" || e.kind === "tool") && !reached.has(e)),
    ...(outcomeless === undefined ? {} : { outcomeless }),
  };
}

/** The messages a log says the loop assembled, as it emitted them. */
export function recordedMessages(
  events: readonly RetraceEvent[],
): { step: number; message: Message }[] {
  return events
    .filter((e): e is Extract<RetraceEvent, { type: "message" }> => e.type === "message")
    .map((e) => ({ step: e.step, message: e.message }));
}
