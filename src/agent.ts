import { randomUUID } from "node:crypto";

import { Budget } from "./budget.ts";
import { BudgetExceededError, ToolNotFoundError } from "./errors.ts";
import { Journal, nestedKey, type EffectOutcome } from "./journal.ts";
import { newRunId, RunStore } from "./store.ts";
import type {
  AgentSpec,
  BudgetSpec,
  ContentBlock,
  ForkOrigin,
  Message,
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

export function defineAgent(spec: Partial<AgentSpec> & { name: string }): AgentSpec {
  return {
    model: "claude-opus-5",
    maxSteps: 12,
    maxTokens: 16_000,
    thinking: "adaptive",
    effort: "high",
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

      const request = {
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
      const stream = onStream && provider.stream ? provider.stream.bind(provider) : undefined;
      const modelCall = await journal.effect<ModelResponse>("model", `step:${step}`, () =>
        stream && onStream
          ? stream(request, (delta) => onStream({ step, replayed: false, delta }))
          : provider.complete(request),
      );
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

      emit({
        type: "effect",
        step,
        index: modelCall.index,
        kind: "model",
        key: `step:${step}`,
        value: response,
        replayed: modelCall.replayed,
        durationMs: modelCall.durationMs,
      });

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
      for (const [ordinal, call] of toolUses.entries()) {
        budget.checkToolCall();
        budget.countToolCall();

        const key = `step:${step}#${ordinal}:${call.name}`;
        const journaled: RecordedEffect[] = [];
        const context = toolContext(journal, step, key, journaled);
        const outcome = await journal.effect<{ content: string; isError: boolean }>(
          "tool",
          key,
          async () => {
            try {
              const tool = toolsByName.get(call.name);
              if (!tool) throw new ToolNotFoundError(call.name, [...toolsByName.keys()]);
              return { content: String(await tool.run(call.input, context)), isError: false };
            } catch (cause) {
              // A failing or missing tool is information for the model, not a
              // crash for the run — hand the error back and let it recover.
              return { content: describe(cause), isError: true };
            }
          },
        );

        emit({
          type: "effect",
          step,
          index: outcome.index,
          kind: "tool",
          key,
          value: outcome.value,
          replayed: outcome.replayed,
          durationMs: outcome.durationMs,
        });

        // What the tool read from the journal, emitted after the tool's own
        // event so the log shows the container before its contents. A replayed
        // tool never ran and so asked for nothing; its reads are copied
        // straight back out, because a replay is supposed to reproduce the log
        // rather than a shorter version of it.
        const reads = outcome.replayed
          ? outcome.nested.map((e) => ({
              kind: e.kind as RecordedEffect["kind"],
              key: e.key,
              value: e.value,
              index: e.index,
              replayed: true,
              durationMs: 0,
            }))
          : journaled.map((e) => ({
              kind: e.kind,
              key: e.key,
              value: e.outcome.value,
              index: e.outcome.index,
              replayed: e.outcome.replayed,
              durationMs: e.outcome.durationMs,
            }));

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
          });
        }

        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: outcome.value.content,
          ...(outcome.value.isError ? { isError: true } : {}),
        });
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

interface RecordedEffect {
  kind: "clock" | "uuid" | "random";
  key: string;
  outcome: EffectOutcome<unknown>;
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
function toolContext(
  journal: Journal,
  step: number,
  ownerKey: string,
  journaled: RecordedEffect[],
): ToolContext {
  const ordinals = new Map<string, number>();

  const take = async <T>(kind: RecordedEffect["kind"], execute: () => T): Promise<T> => {
    const ordinal = ordinals.get(kind) ?? 0;
    ordinals.set(kind, ordinal + 1);
    const key = nestedKey(ownerKey, kind, ordinal);
    const outcome = await journal.deterministic<T>(kind, key, execute);
    journaled.push({ kind, key, outcome });
    return outcome.value;
  };

  return {
    step,
    now: () => take("clock", () => Date.now()),
    uuid: () => take("uuid", () => randomUUID()),
    random: () => take("random", () => Math.random()),
  };
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
