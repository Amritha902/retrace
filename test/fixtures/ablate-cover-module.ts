import {
  objectSchema,
  tool,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/**
 * Two sources that say the same thing, and one that carries the detail.
 *
 * The mirrors are the shape a one-at-a-time ablation reads wrong: with either
 * of them in place the run is verified, so each comes back `spare` while the
 * other stands, and the conclusion needs one of them.
 */
const TERMS = ["mirror-a", "mirror-b", "gamma"];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    // Either mirror is enough to call it verified, which is what makes them
    // individually droppable — and what makes dropping both a different answer.
    const verified = found(seen[0]) || found(seen[1]);
    const content: ContentBlock[] =
      term === undefined
        ? [{ type: "text", text: `${verified ? "verified" : "unverified"}: ${seen[2]}` }]
        : [{ type: "tool_use", id: `t${seen.length}`, name: "lookup", input: { term } }];
    return {
      model: request.model,
      content,
      stopReason: term === undefined ? "end_turn" : "tool_use",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

/** Whether a result is a definition rather than whatever an ablation put there. */
function found(result: string | undefined): boolean {
  return result?.startsWith("definition of ") ?? false;
}

function resultsIn(message: Message): string[] {
  return message.role === "user"
    ? message.content.filter((b) => b.type === "tool_result").map((b) => b.content)
    : [];
}
