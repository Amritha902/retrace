/**
 * Core types. Everything here is JSON-serializable on purpose: the event log is
 * the source of truth, and anything that can't round-trip through JSON can't be
 * replayed.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Provider-agnostic assistant content. Adapters translate to and from this. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type Message =
  | { role: "user"; content: UserBlock[] }
  | {
      role: "assistant";
      content: ContentBlock[];
      /**
       * The provider's own representation of this turn, verbatim. Thinking
       * blocks carry signatures that must be echoed back byte-for-byte, and
       * normalizing them would corrupt the next request — so the adapter keeps
       * the original here and replays it unchanged. It is JSON-serializable and
       * lives in the log alongside the normalized view.
       */
      raw?: unknown;
    };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/**
 * The journal, as a tool sees it. Time, ids and randomness taken from here are
 * recorded and come back unchanged on a replay or a fork; `Date.now()` and
 * `Math.random()` called directly are still just the clock and the RNG.
 */
export interface ToolContext {
  /** Which step of the run this call belongs to. */
  readonly step: number;
  /** Wall clock in epoch milliseconds. */
  now(): Promise<number>;
  /** A version 4 UUID. */
  uuid(): Promise<string>;
  /** A float in [0, 1). */
  random(): Promise<number>;
}

export interface Tool extends ToolSchema {
  /**
   * Executed only when the journal has no recorded result for this call.
   * Must return something JSON-serializable — the return value goes in the log.
   */
  run(input: any, context: ToolContext): Promise<string> | string;
}

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  effort?: Effort;
  thinking?: "adaptive" | "disabled";
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "stop_sequence"
  | "pause_turn";

export interface ModelResponse {
  /** The model that actually produced this message (may differ from the request under fallback). */
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Populated when stopReason is "refusal". */
  refusalCategory?: string | null;
  /** Provider-native content, echoed back verbatim on the next turn. See `Message`. */
  raw?: unknown;
}

/**
 * A fragment of an assistant turn, handed over as it is produced.
 *
 * Deltas are a *view* of a model call, not an effect of their own: the journal
 * records the assembled message and nothing else, so the token stream never
 * reaches the log. That is what keeps a streamed run and an unstreamed one
 * byte-identical on disk, and lets a replay reproduce the fragments offline.
 *
 * A tool call is announced when its block opens; its input arrives whole, in
 * the final message, because partial JSON is not something a caller can use.
 */
export type StreamDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool_use"; id: string; name: string };

export interface StreamEvent {
  step: number;
  /** True when the fragment was reconstructed from the log rather than streamed. */
  replayed: boolean;
  delta: StreamDelta;
}

export interface Provider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  /**
   * Optional. Returns exactly what `complete` would, having handed each
   * fragment to `onDelta` on the way. A provider that omits this still works
   * with a streaming caller — the loop delivers the finished turn in one go.
   */
  stream?(request: ModelRequest, onDelta: (delta: StreamDelta) => void): Promise<ModelResponse>;
}

/** What the agent is: model, instructions, tools, limits. Serialized into the log. */
export interface AgentSpec {
  name: string;
  model: string;
  system?: string;
  maxSteps: number;
  maxTokens: number;
  effort?: Effort;
  thinking?: "adaptive" | "disabled";
  /**
   * Run the tool calls in a step at once instead of one after another. Off by
   * default. The log is the same either way — results are journaled in the
   * order the model asked for them, whatever order they finished in — but the
   * side effects are not, so a tool that writes something wants this off.
   */
  parallelTools?: boolean;
}

export interface BudgetSpec {
  /** Hard ceiling on model spend, in USD, priced from the model's rate card. */
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  steps?: number;
  wallClockMs?: number;
}

export interface Totals {
  steps: number;
  toolCalls: number;
  usage: Usage;
  /** What the run would have cost at list price, replayed steps included. */
  costUsd: number;
  /** What the run actually cost. Replayed steps contribute zero. */
  billedUsd: number;
  /** costUsd - billedUsd: the money the journal saved on this run. */
  savedUsd: number;
  wallClockMs: number;
}

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "budget_exceeded"
  | "refused"
  | "max_steps";

export interface ForkOrigin {
  runId: string;
  /**
   * Steps strictly below this index were replayed from the parent, or "all"
   * for a full replay. A number, not Infinity — the log is JSON, and Infinity
   * does not survive the round trip.
   */
  atStep: number | "all";
  /**
   * Effect keys whose recorded values this run was told to replace. Present
   * only on a counterfactual fork; the substituted values are in the effect
   * events themselves, marked `overridden`.
   */
  overrides?: string[];
}

/**
 * The event log. One JSON object per line, append-only, `seq` strictly increasing.
 * `effect` entries double as the journal — replay reads them back in order.
 */
export type RetraceEvent =
  | {
      seq: number;
      t: number;
      type: "run.started";
      runId: string;
      agent: AgentSpec;
      budget: BudgetSpec;
      input: string;
      provider: string;
      forkedFrom?: ForkOrigin;
    }
  | { seq: number; t: number; type: "step.started"; step: number }
  | {
      seq: number;
      t: number;
      type: "effect";
      step: number;
      /** Position within the run's effect sequence. Dense, zero-based. */
      index: number;
      kind: "model" | "tool" | "clock" | "uuid" | "random";
      /** Semantic identity of this effect. A mismatch on replay means divergence. */
      key: string;
      value: unknown;
      /** True when this effect was served from a parent run's log rather than executed. */
      replayed: boolean;
      /** Milliseconds the effect took to execute. Zero when replayed. */
      durationMs: number;
      /**
       * Digest of the model request this effect answered. Model calls only: a
       * tool call's input below a fork point comes out of the log too, so it
       * cannot drift, whereas a model request is rebuilt every step from the
       * agent spec and the conversation so far — both of which a fork can change.
       */
      requestHash?: string;
      /**
       * Set when this effect was replayed but the request the loop built no
       * longer matches the one it was recorded against. Expected in a fork that
       * changed the prompt; a sign the loop is reading something the journal
       * does not cover if it shows up in a plain replay.
       */
      stale?: true;
      /**
       * Set when this value was served from the log having been substituted for
       * the one recorded there. The log then holds what the run actually saw,
       * and says that it was not what the parent recorded.
       */
      overridden?: true;
    }
  | { seq: number; t: number; type: "charge"; step: number; usage: Usage; costUsd: number; billedUsd: number }
  | { seq: number; t: number; type: "message"; step: number; message: Message }
  | {
      seq: number;
      t: number;
      type: "run.finished";
      status: RunStatus;
      output?: string;
      error?: string;
      totals: Totals;
    };

export interface RunResult {
  runId: string;
  status: RunStatus;
  output: string;
  messages: Message[];
  totals: Totals;
  events: RetraceEvent[];
  error?: string;
}
