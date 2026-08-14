import { objectSchema, tool } from "../../src/index.ts";

/**
 * The same tool as `agent-module.ts`, reading something the journal does not
 * cover. A counter rather than `Date.now()` for the same reason the loop keys
 * deterministic reads by slot: the test has to be sure the two answers differ,
 * and two clock reads in the same millisecond do not.
 *
 * `retrace recheck` against this module is the case that used to be reported as
 * a moved corpus, which is the opposite diagnosis — nothing about the world
 * changed, and re-recording the run would not help.
 */
let reads = 0;

export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term} (read ${++reads})`,
  }),
];
