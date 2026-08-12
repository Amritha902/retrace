import { objectSchema, tool, type RunModule } from "../../src/index.ts";

/** The same contract as agent-module.ts, expressed as a default export. */
export default {
  tools: [
    tool({
      name: "lookup",
      description: "Look a term up.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => `definition of ${input.term}`,
    }),
  ],
  agent: { system: "From the default export." },
} satisfies RunModule;
