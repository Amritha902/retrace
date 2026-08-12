import {
  objectSchema,
  tool,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/**
 * A module of the shape `retrace replay --module` and `retrace fork --module`
 * expect, using named exports.
 *
 * Everything it serves is recorded in `calls`, so a test can prove that a
 * replayed prefix reached neither the provider nor the tools even though both
 * were sitting right there.
 */
export const calls: string[] = [];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => {
      calls.push(`tool:${input.term}`);
      return `definition of ${input.term}`;
    },
  }),
];

export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    calls.push(`model:${request.system}`);
    return {
      model: request.model,
      content: [{ type: "text", text: `live answer, system was "${request.system}"` }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

export const agent = { system: "Answer in one sentence." };
