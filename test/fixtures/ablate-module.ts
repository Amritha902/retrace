import {
  objectSchema,
  tool,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/** The three terms this agent always looks up, in this order. */
const TERMS = ["alpha", "beta", "gamma"];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/**
 * A provider whose answer quotes the first and the last thing it was told, and
 * never the middle one.
 *
 * That is the shape an ablation is for: three recorded answers, two the
 * conclusion rests on and one it does not, and no way to tell them apart by
 * reading the log. Taking each away in turn is what separates them, and a
 * fixture where every result mattered could not tell a working ablation from
 * one that reports everything as load-bearing.
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
