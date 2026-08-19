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

/**
 * The corpus exactly as the run was recorded against it.
 *
 * Nothing here has moved, which is the point: the only thing that can vary
 * between two cuts of one arm is what the model says.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
];

/** How many answers of each kind this provider has given: the whole of its state. */
let hedged = 0;
let brittle = 0;

/** Put the wobble back where a test expects to find it. */
export function resetWobble(): void {
  hedged = 0;
  brittle = 0;
}

/**
 * A provider that answers steadily under one prompt and two ways under another.
 *
 * The thing a sweep cannot tell from an arm taking is a model that would have
 * moved the answer anyway, and the two are only separable if some arms wobble
 * and others don't — so the wobble here is a property of the prompt. An arm
 * asking to be hedged gets a hedge every other time it is cut; every other arm
 * answers from the conversation and the system prompt alone.
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
    const system = request.system ?? "";
    const said = `${system} :: ${seen.join(" | ")}`;
    // The other way a cut can answer differently from the one beside it: not a
    // different answer but no answer, which is a thing the run's status says and
    // its output does not.
    if (system.includes("break")) {
      brittle += 1;
      if (brittle % 2 === 0) throw new Error("the model is overloaded, try again");
      return turn(request, [{ type: "text", text: said }]);
    }
    if (!system.includes("hedge")) return turn(request, [{ type: "text", text: said }]);
    hedged += 1;
    return turn(request, [
      { type: "text", text: hedged % 2 === 1 ? said : `${said}, or so they say` },
    ]);
  },
};

/** One arm whose answer is the arm's, and one whose answer is partly the model's. */
export const arms: SweepArm[] = [
  { name: "steady", agent: { system: "Answer plainly." } },
  { name: "wobbly", agent: { system: "Answer, and hedge it." } },
];

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
