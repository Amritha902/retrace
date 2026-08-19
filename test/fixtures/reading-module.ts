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

/** How many times the corpus was actually asked, across every run in a test. */
let asked = 0;

export const readCount = (): number => asked;
export const resetReads = (): void => {
  asked = 0;
};

/**
 * The same agent `sweep-module` records, with one difference that is the whole
 * point of it: the tool takes its answer from `ctx.read` rather than producing
 * one. A live tail that asks the corpus the same thing the recorded run asked
 * is served the recorded answer, so the counter above stays where the recording
 * left it — which is what a fork inheriting its parent's world looks like from
 * the outside.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx) =>
      String(
        await ctx.read("corpus", input, () => {
          asked++;
          return `definition of ${input.term}`;
        }),
      ),
  }),
];

/** Answers from the conversation and the system prompt, so an arm names itself. */
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

export const arms: SweepArm[] = [
  { name: "terse", agent: { system: "Answer in ten words." } },
  { name: "cited", agent: { system: "Cite what you searched." } },
];

function resultsIn(message: Message): string[] {
  return message.role === "user"
    ? message.content.filter((b) => b.type === "tool_result").map((b) => b.content)
    : [];
}
