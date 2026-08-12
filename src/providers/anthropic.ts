import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
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

    // The `fallbacks` parameter lives on the beta endpoint; the SDK's typings
    // trail the API, so the body is assembled as a plain object above.
    const response = (await this.client.beta.messages.create(body as never)) as SdkMessage;

    return {
      model: response.model ?? request.model,
      content: response.content.flatMap(fromSdkBlock),
      stopReason: (response.stop_reason ?? "end_turn") as StopReason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
      },
      refusalCategory: response.stop_details?.category ?? null,
      raw: response.content,
    };
  }
}

interface SdkMessage {
  model?: string;
  content: SdkBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface SdkBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

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
