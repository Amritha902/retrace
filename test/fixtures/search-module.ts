import {
  objectSchema,
  tool,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/** The two terms this agent always looks up, in this order. */
const TERMS = ["alpha", "beta"];

/** What the corpus says today, which is not what it said when the run was recorded. */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `today's definition of ${input.term}`,
  }),
];

/**
 * A provider with no memory of its own: what it says is a function of the
 * conversation it is handed and nothing else.
 *
 * That is what a search needs from a fixture. A fork at step 2 and a fork at
 * step 1 differ only in how much of the conversation came out of the log, so a
 * provider that answered from its own position in a script would be reporting
 * where the fork cut rather than what the cut changed.
 */
export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    const content: ContentBlock[] =
      term === undefined
        ? [{ type: "text", text: seen.join(" | ") }]
        : [{ type: "tool_use", id: `t${seen.length}`, name: "lookup", input: { term } }];
    return {
      model: request.model,
      content,
      stopReason: term === undefined ? "end_turn" : "tool_use",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

function resultsIn(message: Message): string[] {
  return message.role === "user"
    ? message.content.filter((b) => b.type === "tool_result").map((b) => b.content)
    : [];
}
