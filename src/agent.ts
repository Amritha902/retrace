import { Budget } from "./budget.ts";
import { BudgetExceededError, ToolNotFoundError } from "./errors.ts";
import { Journal } from "./journal.ts";
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
  Tool,
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

      const modelCall = await journal.effect<ModelResponse>("model", `step:${step}`, () =>
        provider.complete({
          model: agent.model,
          system: agent.system,
          // A copy: the loop keeps mutating `messages`, and a provider that
          // held the live array would see turns that hadn't happened yet.
          messages: [...messages],
          tools: schemas,
          maxTokens: agent.maxTokens,
          effort: agent.effort,
          thinking: agent.thinking,
        }),
      );
      const response = modelCall.value;

      emit({
        type: "effect",
        step,
        index: journal.index - 1,
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
        const outcome = await journal.effect<{ content: string; isError: boolean }>(
          "tool",
          key,
          async () => {
            try {
              const tool = toolsByName.get(call.name);
              if (!tool) throw new ToolNotFoundError(call.name, [...toolsByName.keys()]);
              return { content: String(await tool.run(call.input)), isError: false };
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
          index: journal.index - 1,
          kind: "tool",
          key,
          value: outcome.value,
          replayed: outcome.replayed,
          durationMs: outcome.durationMs,
        });

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
