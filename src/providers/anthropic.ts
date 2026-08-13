import Anthropic from "@anthropic-ai/sdk";
import { ZERO_USAGE } from "../types.ts";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
  StreamDelta,
  Usage,
} from "../types.ts";

export interface AnthropicProviderOptions {
  client?: Anthropic;
  apiKey?: string;
  /**
   * Route policy refusals to Anthropic's recommended fallback model instead of
   * returning a refusal. On by default — a refusal that could have been served
   * is a worse outcome than a fallback the caller can see in the log.
   */
  fallbacks?: boolean;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Adapter between Retrace's provider-agnostic message shape and the Anthropic
 * Messages API. The translation is deliberately lossy in one direction: the log
 * stores our own block types, so a run recorded today still replays after the
 * SDK's types change underneath it.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
    this.fallbacks = options.fallbacks ?? true;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // The `fallbacks` parameter lives on the beta endpoint; the SDK's typings
    // trail the API, so the body is assembled as a plain object.
    const response = (await this.client.beta.messages.create(
      this.body(request) as never,
    )) as SdkMessage;

    return {
      model: response.model ?? request.model,
      content: response.content.flatMap(fromSdkBlock),
      stopReason: (response.stop_reason ?? "end_turn") as StopReason,
      usage: mergeUsage(ZERO_USAGE, response.usage),
      refusalCategory: response.stop_details?.category ?? null,
      raw: response.content,
    };
  }

  /**
   * The same call, watched as it arrives.
   *
   * The fragments go to `onDelta`; what comes back is the assembled message,
   * indistinguishable from `complete`'s. Reassembly is the whole job here: a
   * thinking block's signature arrives in pieces and a tool's input arrives as
   * partial JSON, and both have to end up exactly as the unstreamed endpoint
   * would have returned them, because `raw` is echoed back verbatim next turn.
   */
  async stream(
    request: ModelRequest,
    onDelta: (delta: StreamDelta) => void,
  ): Promise<ModelResponse> {
    const events = (await this.client.beta.messages.create({
      ...this.body(request),
      stream: true,
    } as never)) as unknown as AsyncIterable<SdkStreamEvent>;

    const blocks: SdkBlock[] = [];
    const partialJson: string[] = [];
    let model = request.model;
    let stopReason: StopReason = "end_turn";
    let refusalCategory: string | null = null;
    let usage: Usage = ZERO_USAGE;

    // A delta names the block it belongs to, and that block was opened by an
    // earlier event. A miss means the stream was cut or reordered in transit.
    const blockAt = (index: number): SdkBlock => {
      const block = blocks[index];
      if (!block) {
        throw new Error(
          `the model stream sent a delta for content block ${index}, which was never opened — ` +
            "the response was truncated or arrived out of order",
        );
      }
      return block;
    };

    for await (const event of events) {
      switch (event.type) {
        case "message_start":
          model = event.message.model ?? model;
          usage = mergeUsage(usage, event.message.usage);
          break;

        case "content_block_start": {
          const block = { ...event.content_block };
          blocks[event.index] = block;
          if (block.type === "tool_use") {
            partialJson[event.index] = "";
            onDelta({ kind: "tool_use", id: block.id ?? "", name: block.name ?? "" });
          }
          break;
        }

        case "content_block_delta": {
          const block = blockAt(event.index);
          const delta = event.delta;
          if (delta.type === "text_delta") {
            block.text = (block.text ?? "") + delta.text;
            onDelta({ kind: "text", text: delta.text });
          } else if (delta.type === "thinking_delta") {
            block.thinking = (block.thinking ?? "") + delta.thinking;
            onDelta({ kind: "thinking", thinking: delta.thinking });
          } else if (delta.type === "signature_delta") {
            block.signature = (block.signature ?? "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            partialJson[event.index] = (partialJson[event.index] ?? "") + delta.partial_json;
          }
          break;
        }

        case "content_block_stop": {
          // Empty for a tool called with no arguments: no input deltas arrive,
          // and the block keeps the `{}` it opened with.
          const json = partialJson[event.index];
          if (json) blockAt(event.index).input = JSON.parse(json);
          break;
        }

        case "message_delta":
          stopReason = (event.delta.stop_reason ?? stopReason) as StopReason;
          refusalCategory = event.delta.stop_details?.category ?? refusalCategory;
          usage = mergeUsage(usage, event.usage);
          break;

        case "error":
          throw new Error(
            `the model stream failed partway through: ${event.error.type} — ${event.error.message}`,
          );

        default:
          break;
      }
    }

    return {
      model,
      content: blocks.flatMap(fromSdkBlock),
      stopReason,
      usage,
      refusalCategory,
      raw: blocks,
    };
  }

  private body(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: request.messages.map(toSdkMessage),
    };
    if (request.system !== undefined) body["system"] = request.system;
    if (request.tools.length > 0) {
      body["tools"] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    if (request.thinking !== undefined) {
      body["thinking"] =
        request.thinking === "adaptive" ? { type: "adaptive" } : { type: "disabled" };
    }
    if (request.effort !== undefined) body["output_config"] = { effort: request.effort };
    if (this.fallbacks) {
      body["fallbacks"] = "default";
      body["betas"] = [FALLBACK_BETA];
    }
    return body;
  }
}

function mergeUsage(base: Usage, update: SdkUsage | undefined): Usage {
  if (!update) return base;
  return {
    inputTokens: update.input_tokens ?? base.inputTokens,
    outputTokens: update.output_tokens ?? base.outputTokens,
    cacheReadTokens: update.cache_read_input_tokens ?? base.cacheReadTokens,
    cacheWriteTokens: update.cache_creation_input_tokens ?? base.cacheWriteTokens,
  };
}

interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface SdkMessage {
  model?: string;
  content: SdkBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: SdkUsage;
}

interface SdkBlock {
  type: string;
  text?: string;
  thinking?: string;
  /** Signed by the API, carried through `raw`, never reconstructed. */
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * The server-sent events of a streamed message. Only the ones that carry
 * content or accounting are listed; ping and message_stop fall through.
 */
type SdkStreamEvent =
  | { type: "message_start"; message: SdkMessage }
  | { type: "content_block_start"; index: number; content_block: SdkBlock }
  | { type: "content_block_delta"; index: number; delta: SdkDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null; stop_details?: { category?: string | null } | null };
      usage?: SdkUsage;
    }
  | { type: "error"; error: { type: string; message: string } }
  | { type: "message_stop" | "ping" };

type SdkDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

function fromSdkBlock(block: SdkBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text ?? "" }];
    case "thinking":
      // Empty when `display` is omitted, which is the default. Keep the block
      // anyway so the step count in the log matches what the model produced.
      return [{ type: "thinking", thinking: block.thinking ?? "" }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input }];
    default:
      // Server tool blocks, fallback markers, and anything the API adds later.
      // Dropping them keeps the log clean; they carry no instruction for the loop.
      return [];
  }
}

function toSdkMessage(message: Message): { role: string; content: unknown } {
  if (message.role === "assistant") {
    // Prefer the provider's own blocks. Thinking blocks are signed and must go
    // back exactly as they arrived; a normalized reconstruction would 400.
    if (Array.isArray(message.raw)) {
      return { role: "assistant", content: message.raw };
    }
    return {
      role: "assistant",
      content: message.content
        .filter((b) => b.type !== "thinking")
        .map((b) =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : { type: "tool_use", id: b.id, name: b.name, input: b.input },
        ),
    };
  }
  return {
    role: "user",
    content: message.content.map((b) =>
      b.type === "text"
        ? { type: "text", text: b.text }
        : {
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          },
    ),
  };
}
