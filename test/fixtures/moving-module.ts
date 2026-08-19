import { objectSchema, tool } from "../../src/index.ts";

export { provider } from "./ablate-module.ts";

/** Terms this corpus has already been asked for, in this process. */
const seen = new Set<string>();

/**
 * The same lookup, from a corpus that answers a second execution differently.
 *
 * Nothing about a recorded run changes — each term is looked up once, and the
 * log holds what it said then. What changes is what a *fork* sees: its live
 * tail re-executes the calls above its cut and gets the corpus as it is now.
 *
 * That is the ordinary way an ablation goes wrong. The answer moves, the trial
 * reports the value it dropped as needed, and the value had nothing to do with
 * it. Re-entering the same cut with nothing dropped is what tells the two
 * apart, which is the thing this fixture exists to demonstrate.
 */
export const tools = [
  tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => {
      const again = seen.has(input.term);
      seen.add(input.term);
      return again ? `definition of ${input.term} (again)` : `definition of ${input.term}`;
    },
  }),
];
