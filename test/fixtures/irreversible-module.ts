import {
  objectSchema,
  tool,
  type ModelRequest,
  type ModelResponse,
  type Provider,
} from "../../src/index.ts";

/**
 * A module whose tool list contains one tool that cannot be run twice.
 *
 * `sent` is what makes the CLI tests worth anything: the point is not that the
 * command printed a warning, it is that the mail was not sent.
 */
export const sent: string[] = [];

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term}`,
  }),
  tool({
    name: "send_email",
    description: "Send an email. Call this once the answer is ready to go out.",
    inputSchema: objectSchema({ to: { type: "string" } }),
    irreversible: true,
    run: (input: { to: string }) => {
      sent.push(input.to);
      return `sent to ${input.to}`;
    },
  }),
];

export const provider: Provider = {
  name: "fixture",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      model: request.model,
      content: [{ type: "text", text: "live answer" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};
