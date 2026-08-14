import { objectSchema, tool } from "../../src/index.ts";

/**
 * The same tool as `agent-module.ts`, having changed its mind — the corpus it
 * reads moved underneath a recorded run. `retrace recheck` against this module
 * is the failure it exists to catch.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `revised definition of ${input.term}`,
  }),
];
