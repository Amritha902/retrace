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

/**
 * The corpus exactly as the run was recorded against it.
 *
 * Nothing here has moved, which is the point: the only thing that varies
 * between two identical forks of this module is what the model says.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/** How many answers this provider has given, which is the whole of its state. */
let answers = 0;

/** Put the wobble back where a test expects to find it. */
export function resetWobble(): void {
  answers = 0;
}

/**
 * A provider that answers one way and then the other, and means neither of them.
 *
 * A model with a temperature is the thing a search cannot tell from a change
 * taking: fork the same point twice and the answer moves on its own. This is
 * that, made repeatable — the lookups are a function of the conversation, and
 * only the final answer alternates, so every fork of this module makes exactly
 * one draw whatever step it cut at.
 */
export const provider: Provider = {
  name: "wobble",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    if (term !== undefined) {
      return turn(request, [{ type: "tool_use", id: `t${seen.length}`, name: "lookup", input: { term } }]);
    }
    const said = seen.join(" | ");
    answers += 1;
    return turn(request, [
      { type: "text", text: answers % 2 === 1 ? said : `${said}, or so they say` },
    ]);
  },
};

function turn(request: ModelRequest, content: ContentBlock[]): ModelResponse {
  return {
    model: request.model,
    content,
    stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function resultsIn(message: Message): string[] {
  return message.role === "user"
    ? message.content.filter((b) => b.type === "tool_result").map((b) => b.content)
    : [];
}
