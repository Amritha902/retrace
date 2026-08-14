import { randomUUID } from "node:crypto";

import { Budget } from "./budget.ts";
import { BudgetExceededError, ToolNotFoundError } from "./errors.ts";
import {
  DETERMINISTIC_KINDS,
  Journal,
  nestedKey,
  type EffectOutcome,
  type Stamp,
} from "./journal.ts";
import { fingerprint, newRunId, RunStore } from "./store.ts";
import type {
  AgentSpec,
  BudgetSpec,
  ContentBlock,
  ForkOrigin,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  RetraceEvent,
  RunResult,
  RunStatus,
  StreamDelta,
  StreamEvent,
  Tool,
  ToolContext,
  UserBlock,
} from "./types.ts";

export interface RunOptions {
  agent: AgentSpec;
  provider: Provider;
  tools?: Tool[];
  budget?: BudgetSpec;
  store?: RunStore;
  runId?: string;
  /** Preloaded effects. Supplied by `fork`; leave unset for a fresh run. */
  journal?: Journal;
  forkedFrom?: ForkOrigin;
  /** Called for every event as it is written. Useful for live progress output. */
  onEvent?: (event: RetraceEvent) => void;
  /**
   * Called for each fragment of each assistant turn. Setting it puts the loop
   * on the provider's streaming path where there is one; the log is the same
   * either way, because what gets journaled is the assembled message.
   */
  onStream?: (event: StreamEvent) => void;
}

/**
 * The components of a request, in the order a reader most wants to hear about
 * them: the things you change on purpose first, the things you change by
 * accident last.
 */
export const REQUEST_FACETS = ["model", "system", "tools", "conversation", "settings"] as const;

export type RequestFacet = (typeof REQUEST_FACETS)[number];

/**
 * The same, for a tool call. There is only one component, because the tool's
 * name is already in the effect's key: a call to a different tool lands in a
 * different slot and is a divergence rather than a staleness. What it was asked
 * is all that is left, and all that decides what it would have answered.
 */
export const TOOL_FACETS = ["input"] as const;

export type ToolFacet = (typeof TOOL_FACETS)[number];

/** Every facet name this build writes, in the order every surface prints them. */
const FACET_ORDER: readonly string[] = [...REQUEST_FACETS, ...TOOL_FACETS];

/**
 * A short digest of everything about a request that could change the answer to
 * it, recorded beside the answer in the log.
 *
 * This is what lets a replayed model call say whether it is still answering the
 * question being asked. Fork a run at step 3 with a rewritten system prompt and
 * steps 0–2 come back out of the log unchanged — correct, and the whole point,
 * but they were said to a different agent. Now the log says so.
 *
 * `raw` is deliberately excluded. It is the provider's own rendering of content
 * that `content` already covers, so hashing it would make a log recorded today
 * look changed tomorrow because the SDK reshaped a field.
 */
export function requestFingerprint(request: ModelRequest): string {
  return fingerprint({
    model: request.model,
    system: request.system,
    messages: request.messages.map((m) =>
      m.role === "assistant" ? { role: m.role, content: m.content } : m,
    ),
    tools: request.tools,
    maxTokens: request.maxTokens,
    effort: request.effort,
    thinking: request.thinking,
  });
}

/**
 * The same digest, taken one component at a time.
 *
 * `requestFingerprint` can only say that a replayed step is answering an older
 * question. This says which part of the question changed, which is the
 * difference between a fork doing what you asked and a fork you have
 * misconfigured: rewriting the system prompt should move `system` and nothing
 * else, so `tools` moving too means the module you passed does not declare the
 * tools the run was recorded with.
 *
 * Every field `requestFingerprint` hashes belongs to exactly one facet here.
 * If it did not, a change could move the hash without any facet naming it, and
 * a stale step would have no explanation — `test/stale.test.ts` holds the two
 * to that.
 */
export function requestFacets(request: ModelRequest): Record<RequestFacet, string> {
  return {
    model: fingerprint(request.model),
    system: fingerprint(request.system ?? null),
    tools: fingerprint(request.tools),
    conversation: fingerprint(
      request.messages.map((m) =>
        m.role === "assistant" ? { role: m.role, content: m.content } : m,
      ),
    ),
    settings: fingerprint({
      maxTokens: request.maxTokens,
      effort: request.effort,
      thinking: request.thinking,
    }),
  };
}

/**
 * Facet names in `FACET_ORDER`, so every surface that prints them prints them
 * the same way. A name from a log this build does not know about sorts to the
 * end rather than being dropped — an older or newer writer's facet is still
 * something that moved.
 */
export function orderFacets(names: readonly string[]): string[] {
  const rank = (n: string): number => {
    const i = FACET_ORDER.indexOf(n);
    return i === -1 ? FACET_ORDER.length : i;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

/**
 * A digest of the call a tool is about to be made with, recorded beside its
 * result — the same idea as `requestFingerprint`, for the other half of the log.
 *
 * A tool call was long treated as unable to drift: its input comes from a model
 * response, and below a fork point that response comes out of the log too. That
 * holds right up until something replaces the model response — an
 * [override](../README.md#what-if-it-had-said-something-else), a hand-edited or
 * spliced log — and then the loop asks `step:0#0:search` for a different query
 * and is handed the answer to the old one, silently, because the slot matches.
 * Stamping the call is what makes that visible instead.
 *
 * The tool's own name is deliberately not in here; see `TOOL_FACETS`.
 */
export function toolFingerprint(call: ToolUse): string {
  return fingerprint(call.input);
}

/** The same digest per component. One component, so far. */
export function toolFacets(call: ToolUse): Record<ToolFacet, string> {
  return { input: fingerprint(call.input) };
}

/** What a tool call is stamped with, for the journal to compare and the log to hold. */
function toolStamp(call: ToolUse): Stamp {
  return { hash: toolFingerprint(call), facets: toolFacets(call) };
}

export function defineAgent(spec: Partial<AgentSpec> & { name: string }): AgentSpec {
  return {
    model: "claude-opus-5",
    maxSteps: 12,
    maxTokens: 16_000,
    thinking: "adaptive",
    effort: "high",
    parallelTools: false,
    ...spec,
  };
}

/**
 * Run an agent to completion.
 *
 * The loop itself is unremarkable — call the model, run the tools it asked for,
 * feed the results back. What matters is that every call to the outside world
 * goes through `journal.effect`, so the same function serves a fresh run, a
 * bit-for-bit replay, and a fork that goes live partway through.
 */
export async function run(input: string, options: RunOptions): Promise<RunResult> {
  const {
    agent,
    provider,
    tools = [],
    budget: budgetSpec = {},
    store = new RunStore(),
    onEvent,
    onStream,
  } = options;

  const runId = options.runId ?? newRunId();
  const journal = options.journal ?? new Journal();
  const budget = new Budget(budgetSpec);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const schemas = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const events: RetraceEvent[] = [];
  let seq = 0;
  const emit = <E extends Omit<RetraceEvent, "seq" | "t">>(event: E): void => {
    const full = { ...event, seq: seq++, t: Date.now() } as unknown as RetraceEvent;
    events.push(full);
    store.append(runId, full);
    onEvent?.(full);
  };

  emit({
    type: "run.started",
    runId,
    agent,
    budget: budgetSpec,
    input,
    provider: provider.name,
    tools: schemas,
    ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
  });

  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: input }] }];
  let status: RunStatus = "running";
  let output = "";
  let error: string | undefined;

  try {
    for (let step = 0; step < agent.maxSteps; step++) {
      budget.checkStep();
      budget.countStep();
      emit({ type: "step.started", step });

      const request: ModelRequest = {
        model: agent.model,
        system: agent.system,
        // A copy: the loop keeps mutating `messages`, and a provider that
        // held the live array would see turns that hadn't happened yet.
        messages: [...messages],
        tools: schemas,
        maxTokens: agent.maxTokens,
        effort: agent.effort,
        thinking: agent.thinking,
      };
      const requestHash = requestFingerprint(request);
      const facets = requestFacets(request);
      const stream = onStream && provider.stream ? provider.stream.bind(provider) : undefined;
      const modelCall = await journal.effect<ModelResponse>(
        "model",
        `step:${step}`,
        () =>
          stream && onStream
            ? stream(request, (delta) => onStream({ step, replayed: false, delta }))
            : provider.complete(request),
        { hash: requestHash, facets },
      );
      emit({
        type: "effect",
        step,
        index: modelCall.index,
        kind: "model",
        key: `step:${step}`,
        value: modelCall.failed ? null : modelCall.value,
        replayed: modelCall.replayed,
        durationMs: modelCall.durationMs,
        requestHash,
        requestFacets: facets,
        ...(modelCall.failed ? { failed: modelCall.failed } : {}),
        ...(modelCall.stale ? { stale: true } : {}),
        // Recorded rather than derived: this log holds the request this run
        // built, and the one it no longer matches is in the parent's.
        ...(modelCall.staleFacets.length > 0
          ? { staleFacets: orderFacets(modelCall.staleFacets) }
          : {}),
        ...(modelCall.overridden ? { overridden: true } : {}),
      });

      // Only now that the log holds it. The run is over either way, and the
      // catch below turns this into the `failed` status; what the event above
      // buys is a log that replays into the same failure instead of into a
      // live call that might succeed.
      if (modelCall.failed) throw modelCall.thrown;

      const response = modelCall.value;

      // The stream is a view of the model call, never an effect of its own, so
      // the log holds the assembled message and nothing more. That leaves the
      // fragments to be reconstructed here for a caller that wanted them but
      // didn't get them off the wire — a replayed step, or a provider with no
      // streaming path. Coarser than the live version, and the same text.
      if (onStream && (modelCall.replayed || stream === undefined)) {
        for (const delta of fragmentsOf(response.content)) {
          onStream({ step, replayed: modelCall.replayed, delta });
        }
      }

      const charged = budget.charge(response.model, response.usage, modelCall.replayed);
      emit({
        type: "charge",
        step,
        usage: response.usage,
        costUsd: charged.costUsd,
        billedUsd: charged.billedUsd,
      });

      const assistant: Message = {
        role: "assistant",
        content: response.content,
        ...(response.raw === undefined ? {} : { raw: response.raw }),
      };
      messages.push(assistant);
      emit({ type: "message", step, message: assistant });

      if (response.stopReason === "refusal") {
        status = "refused";
        error = `the model declined this request${
          response.refusalCategory ? ` (${response.refusalCategory})` : ""
        }`;
        break;
      }

      const toolUses = response.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        status = "completed";
        output = textOf(response.content);
        break;
      }

      const results: UserBlock[] = [];

      /** The tool's own effect, then whatever it read while it ran. */
      const emitToolCall = (
        key: string,
        stamp: Stamp,
        outcome: EffectOutcome<ToolResult>,
        durationMs: number,
        reads: readonly RecordedRead[],
      ): void => {
        emit({
          type: "effect",
          step,
          index: outcome.index,
          kind: "tool",
          key,
          value: outcome.value,
          replayed: outcome.replayed,
          durationMs,
          requestHash: stamp.hash,
          requestFacets: stamp.facets,
          ...(outcome.stale ? { stale: true } : {}),
          ...(outcome.staleFacets.length > 0
            ? { staleFacets: orderFacets(outcome.staleFacets) }
            : {}),
          ...(outcome.overridden ? { overridden: true } : {}),
        });
        // After the tool's own event, so the log shows the container before its
        // contents.
        for (const read of reads) {
          emit({
            type: "effect",
            step,
            index: read.index,
            kind: read.kind,
            key: read.key,
            value: read.value,
            replayed: read.replayed,
            durationMs: read.durationMs,
            ...(read.overridden ? { overridden: true } : {}),
          });
        }
      };

      const runOne = async (ordinal: number, call: ToolUse): Promise<void> => {
        const key = toolKey(step, ordinal, call.name);
        const journaled: RecordedRead[] = [];
        const context = journaledContext(journal, step, key, journaled);
        const stamp = toolStamp(call);
        const outcome = await journal.effect<ToolResult>(
          "tool",
          key,
          () => invoke(toolsByName, call, context),
          stamp,
        );

        emitToolCall(
          key,
          stamp,
          outcome,
          outcome.durationMs,
          // A replayed tool never ran and so asked for nothing; its reads are
          // copied straight back out, because a replay is supposed to reproduce
          // the log rather than a shorter version of it.
          outcome.replayed ? replayedReads(outcome) : journaled,
        );
        results.push(toolResult(call, outcome.value));
      };

      /**
       * The same, for several calls at once.
       *
       * Two phases, and the split is the whole trick. The bodies run
       * concurrently against a detached view of the journal — reads resolve by
       * key, and a key does not depend on who reached it first — and then the
       * results are committed through `journal.effect` in the order the model
       * asked for them. What lands in the log is what a sequential step would
       * have written, slot for slot; only the execution overlapped.
       */
      const runAtOnce = async (from: number, calls: readonly ToolUse[]): Promise<void> => {
        const executed = await Promise.all(
          calls.map(async (call, i) => {
            const key = toolKey(step, from + i, call.name);
            const reads: DetachedRead[] = [];
            const context = detachedContext(journal, step, key, reads);
            const startedAt = Date.now();
            const value = await invoke(toolsByName, call, context);
            return { key, value, reads, durationMs: Date.now() - startedAt };
          }),
        );

        for (const [i, done] of executed.entries()) {
          const call = calls[i]!;
          const stamp = toolStamp(call);
          const outcome = await journal.effect<ToolResult>(
            "tool",
            done.key,
            () => done.value,
            stamp,
          );
          const journaled: RecordedRead[] = [];
          for (const read of done.reads) {
            const committed = await journal.deterministic(read.kind, read.key, () => read.value);
            journaled.push({ kind: read.kind, key: read.key, ...committed });
          }
          emitToolCall(done.key, stamp, outcome, done.durationMs, journaled);
          results.push(toolResult(call, outcome.value));
        }
      };

      // A call the log can serve does not execute, so there is nothing to
      // overlap — and the log's order is the only order it has. Parallelism is
      // for the live tail, which in a plain run is the whole step and in a fork
      // is whatever sits above the fork point.
      let ordinal = 0;
      while (ordinal < toolUses.length && journal.isReplaying) {
        budget.checkToolCall();
        budget.countToolCall();
        await runOne(ordinal, toolUses[ordinal]!);
        ordinal++;
      }

      const live = toolUses.slice(ordinal);
      if (agent.parallelTools && live.length > 1) {
        // Charged before any of them starts: a batch that would run out of
        // budget halfway is refused whole, rather than leaving the log holding
        // part of a step that never finished.
        for (let i = 0; i < live.length; i++) {
          budget.checkToolCall();
          budget.countToolCall();
        }
        await runAtOnce(ordinal, live);
      } else {
        for (const [i, call] of live.entries()) {
          budget.checkToolCall();
          budget.countToolCall();
          await runOne(ordinal + i, call);
        }
      }

      const toolMessage: Message = { role: "user", content: results };
      messages.push(toolMessage);
      emit({ type: "message", step, message: toolMessage });
    }

    if (status === "running") {
      status = "max_steps";
      error = `stopped after ${agent.maxSteps} steps without a final answer`;
      output = lastAssistantText(messages);
    }
  } catch (cause) {
    if (cause instanceof BudgetExceededError) {
      status = "budget_exceeded";
    } else {
      status = "failed";
    }
    error = describe(cause);
    output = lastAssistantText(messages);
  }

  const totals = budget.totals();
  emit({
    type: "run.finished",
    status,
    output,
    ...(error === undefined ? {} : { error }),
    totals,
  });

  return {
    runId,
    status,
    output,
    messages,
    totals,
    events,
    ...(error === undefined ? {} : { error }),
  };
}

export type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResult = { content: string; isError: boolean };
type DeterministicKind = (typeof DETERMINISTIC_KINDS)[number];

/** A journal read a tool made, ready to go in the log. */
interface RecordedRead {
  kind: DeterministicKind;
  key: string;
  value: unknown;
  index: number;
  replayed: boolean;
  overridden: boolean;
  durationMs: number;
}

/** A read whose value is settled but whose slot in the log is not yet claimed. */
interface DetachedRead {
  kind: DeterministicKind;
  key: string;
  value: unknown;
}

/** How a tool context resolves one read. The two callers differ only in this. */
type Take = <T>(kind: DeterministicKind, key: string, execute: () => T | Promise<T>) => Promise<T>;

/** The reads recorded inside a tool call that was itself served from the log. */
function replayedReads(outcome: EffectOutcome<ToolResult>): RecordedRead[] {
  return outcome.nested.map((e) => ({
    kind: e.kind as DeterministicKind,
    key: e.key,
    value: e.value,
    index: e.index,
    replayed: true,
    overridden: e.overridden === true,
    durationMs: 0,
  }));
}

/**
 * Where a tool call lands in the log. Exported because anything that reads a
 * recorded call back — `recheck` — has to name it the way the loop named it,
 * and deriving the format twice is how the two come to disagree.
 */
export function toolKey(step: number, ordinal: number, name: string): string {
  return `step:${step}#${ordinal}:${name}`;
}

/**
 * Call a tool and turn whatever happens into something the model can read. A
 * failing or missing tool is information for the model, not a crash for the
 * run — hand the error back and let it recover.
 */
export async function invoke(
  tools: ReadonlyMap<string, Tool>,
  call: ToolUse,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const tool = tools.get(call.name);
    if (!tool) throw new ToolNotFoundError(call.name, [...tools.keys()]);
    return { content: String(await tool.run(call.input, context)), isError: false };
  } catch (cause) {
    return { content: describe(cause), isError: true };
  }
}

function toolResult(call: ToolUse, value: ToolResult): UserBlock {
  return {
    type: "tool_result",
    toolUseId: call.id,
    content: value.content,
    ...(value.isError ? { isError: true } : {}),
  };
}

/**
 * The journal handed to a single tool call.
 *
 * Each read is keyed by the call it happened in and its ordinal within that
 * call, so the same tool asking for the time twice gets two slots and a replay
 * hands each one back the value it had. Adding a read shifts the ordinals after
 * it — which is correct: that is a different tool, and it should get fresh
 * values rather than inherit someone else's.
 */
function toolContext(step: number, ownerKey: string, take: Take): ToolContext {
  const ordinals = new Map<string, number>();

  const at = <T>(kind: DeterministicKind, execute: () => T): Promise<T> => {
    const ordinal = ordinals.get(kind) ?? 0;
    ordinals.set(kind, ordinal + 1);
    return take(kind, nestedKey(ownerKey, kind, ordinal), execute);
  };

  return {
    step,
    now: () => at("clock", () => Date.now()),
    uuid: () => at("uuid", () => randomUUID()),
    random: () => at("random", () => Math.random()),
  };
}

/** Reads go through the journal as they happen, and claim their slots there. */
function journaledContext(
  journal: Journal,
  step: number,
  ownerKey: string,
  journaled: RecordedRead[],
): ToolContext {
  const take = async <T>(
    kind: DeterministicKind,
    key: string,
    execute: () => T | Promise<T>,
  ): Promise<T> => {
    const read = await journal.deterministic<T>(kind, key, execute);
    journaled.push({ kind, key, ...read });
    return read.value;
  };
  return toolContext(step, ownerKey, take);
}

/**
 * Reads resolve now; their slots are claimed later, when the batch that
 * produced them is committed in order.
 *
 * The value has to settle here — the tool is about to use it — but it can,
 * because a deterministic read resolves by key. `recall` gives the same answer
 * whenever it is asked, so two tools running at once cannot change what the
 * other one reads.
 */
function detachedContext(
  journal: Journal,
  step: number,
  ownerKey: string,
  reads: DetachedRead[],
): ToolContext {
  const take = async <T>(
    kind: DeterministicKind,
    key: string,
    execute: () => T | Promise<T>,
  ): Promise<T> => {
    const recorded = journal.recall(kind, key);
    const value = recorded === undefined ? await execute() : (recorded as T);
    reads.push({ kind, key, value });
    return value;
  };
  return toolContext(step, ownerKey, take);
}

/**
 * A tool context for re-executing a recorded call outside a run.
 *
 * Reads resolve to whatever the log holds at the same slots, and a slot the log
 * never filled reads the world. `recheck` needs this so that a tool which
 * stamps `now()` into what it returns is compared on what it said rather than
 * on when it was asked.
 */
export function recordedContext(journal: Journal, step: number, ownerKey: string): ToolContext {
  return detachedContext(journal, step, ownerKey, []);
}

/** An assembled turn, cut back into the fragments a stream would have produced. */
function fragmentsOf(content: ContentBlock[]): StreamDelta[] {
  return content.map((block) => {
    if (block.type === "text") return { kind: "text", text: block.text };
    if (block.type === "thinking") return { kind: "thinking", thinking: block.thinking };
    return { kind: "tool_use", id: block.id, name: block.name };
  });
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return textOf(m.content);
  }
  return "";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
