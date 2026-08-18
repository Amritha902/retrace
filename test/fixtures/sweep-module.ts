import {
  objectSchema,
  tool,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type SweepArm,
} from "../../src/index.ts";

/** The two terms this agent always looks up, in this order. */
const TERMS = ["alpha", "beta"];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/**
 * A provider that answers from the conversation and the system prompt, and from
 * nothing else.
 *
 * A sweep needs both halves. The conversation is what an arm varying the world
 * moves, the system prompt is what an arm varying the agent moves, and an
 * answer that names them says which arm produced it — so a report that mixed
 * two arms up would be caught by reading it.
 */
export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    const content: ContentBlock[] =
      term === undefined
        ? [{ type: "text", text: `${request.system ?? ""} :: ${seen.join(" | ")}` }]
        : [{ type: "tool_use", id: `t${seen.length}`, name: "lookup", input: { term } }];
    return {
      model: request.model,
      content,
      stopReason: term === undefined ? "end_turn" : "tool_use",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

/**
 * Three questions to put to the same recorded prefix: two that rewrite the
 * prompt and one that rewrites what the corpus said.
 */
export const arms: SweepArm[] = [
  { name: "terse", agent: { system: "Answer in ten words." } },
  { name: "cited", agent: { system: "Cite what you searched." } },
  { name: "empty-corpus", overrides: { "step:0#0:lookup": "no results" } },
];

function resultsIn(message: Message): string[] {
  return message.role === "user"
    ? message.content.filter((b) => b.type === "tool_result").map((b) => b.content)
    : [];
}
