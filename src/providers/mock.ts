import type {
  ContentBlock,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
  Usage,
} from "../types.ts";

export interface ScriptedTurn {
  content: ContentBlock[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
}

/**
 * A provider that reads its answers off a script. Used by the test suite and by
 * anyone who wants to exercise an agent's control flow without spending money.
 *
 * `calls` records every request it received, which is how tests assert that a
 * replayed run never reached the network.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly calls: ModelRequest[] = [];
  private turn = 0;
  private readonly script: ScriptedTurn[];

  constructor(script: ScriptedTurn[]) {
    this.script = script;
  }

  get callCount(): number {
    return this.calls.length;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const scripted = this.script[this.turn];
    this.turn += 1;
    if (!scripted) {
      throw new Error(
        `MockProvider ran out of script: turn ${this.turn} requested, ${this.script.length} scripted`,
      );
    }
    const hasToolUse = scripted.content.some((b) => b.type === "tool_use");
    return {
      model: request.model,
      content: scripted.content,
      stopReason: scripted.stopReason ?? (hasToolUse ? "tool_use" : "end_turn"),
      usage: {
        inputTokens: scripted.usage?.inputTokens ?? 1000,
        outputTokens: scripted.usage?.outputTokens ?? 100,
        cacheReadTokens: scripted.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: scripted.usage?.cacheWriteTokens ?? 0,
      },
    };
  }
}

export function text(s: string): ContentBlock {
  return { type: "text", text: s };
}

export function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}
