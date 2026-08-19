import {
  objectSchema,
  tool,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/** Four terms, and a conclusion that quotes the first and the last of them. */
const TERMS = ["alpha", "beta", "gamma", "delta"];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/**
 * The other half of the joint drop's question: two answers the conclusion
 * genuinely does without.
 *
 * Neither of the middle two is in the answer and neither stands in for the
 * other, so taking both away at once changes nothing — which is the reading a
 * column of `spare` verdicts invites and the one a covering pair would break.
 */
export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    const content: ContentBlock[] =
      term === undefined
        ? [{ type: "text", text: `${seen.at(0)} + ${seen.at(-1)}` }]
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
