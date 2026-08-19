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

/**
 * The corpus exactly as the run was recorded against it.
 *
 * Nothing here has moved, which is the point: the cut reproduces, so the only
 * thing that can vary between two forks that dropped the same value is what the
 * model says about the gap.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/** How many answers this provider has given about a missing beta: its whole state. */
let hedged = 0;

/** Put the wobble back where a test expects to find it. */
export function resetWobble(): void {
  hedged = 0;
}

/**
 * A model that answers steadily, except about one thing it was not told.
 *
 * A baseline rules out the cut: re-enter with nothing dropped and the run comes
 * back to its own answer. What it cannot rule out is the drop itself being
 * answered two ways — a model handed a gap where a result should be will
 * sometimes work around it and sometimes say so, and one trial cannot tell that
 * from a dependency. So the wobble here is a property of the missing value: the
 * middle lookup going astray is answered one way and then the other, and every
 * other conversation is a function of what the model was told.
 */
export const provider: Provider = {
  name: "wobble",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seen = request.messages.flatMap(resultsIn);
    const term = TERMS[seen.length];
    if (term !== undefined) {
      return turn(request, [
        { type: "tool_use", id: `t${seen.length}`, name: "lookup", input: { term } },
      ]);
    }
    const said = `${seen.at(0)} + ${seen.at(-1)}`;
    if (seen[1] === `definition of ${TERMS[1]}`) return turn(request, [{ type: "text", text: said }]);
    hedged += 1;
    return turn(request, [
      { type: "text", text: hedged % 2 === 1 ? said : `${said}, on what is left` },
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
