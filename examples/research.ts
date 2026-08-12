/**
 * The same flow against the real Claude API, written as a `--module`: the file
 * exports the live half of the run — tools, a provider, the agent spec — and
 * runs the agent only when you execute it directly.
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node examples/research.ts "How do heat pumps work in cold climates?"
 *
 * Run it once to record. Then rewrite the last step without paying for the
 * research again — edit the `system` line below and fork:
 *
 *   npx retrace ls
 *   npx retrace fork <run-id> --at 3 --module examples/research.ts
 */
import { pathToFileURL } from "node:url";
import {
  AnthropicProvider,
  defineAgent,
  formatUsd,
  objectSchema,
  run,
  RunStore,
  tool,
  type RunModule,
} from "../src/index.ts";

const notes = new Map<string, string>([
  ["heat pump", "Moves heat rather than generating it; efficiency falls as outdoor air cools."],
  ["cold climate", "Modern variable-speed compressors hold usable output down to about -25C."],
  ["backup heat", "Resistive strips or a furnace cover the coldest hours in a hybrid setup."],
]);

const lookup = tool({
  name: "lookup",
  description:
    "Look up an internal engineering note by topic. Call this before answering any factual " +
    "question about equipment — the notes are more current than your training data.",
  inputSchema: objectSchema({
    topic: { type: "string", description: "Topic to look up, e.g. 'heat pump'" },
  }),
  run: (input: { topic: string }) => {
    const hit = [...notes.entries()].find(([k]) => input.topic.toLowerCase().includes(k));
    return hit ? hit[1] : `No note on "${input.topic}". Try: ${[...notes.keys()].join(", ")}`;
  },
});

export const tools: RunModule["tools"] = [lookup];
export const provider: RunModule["provider"] = new AnthropicProvider();

export const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are a careful technical writer. Look things up before you assert them.",
  maxSteps: 8,
  effort: "high",
});

const budget = { usd: 2, wallClockMs: 5 * 60_000 };

// Importing this file must not run the agent — `retrace fork --module` imports
// it for the exports above.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const question = process.argv.slice(2)[0] ?? "How do heat pumps work in the cold?";
  const result = await run(question, {
    agent,
    provider,
    tools,
    budget,
    store: new RunStore(),
    onEvent: (event) => {
      if (event.type !== "effect") return;
      console.log(`  [${event.replayed ? "replayed" : "live"}] ${event.kind} ${event.key}`);
    },
  });

  console.log(`\n${result.output}\n`);
  console.log(
    `${result.runId} · ${result.status} · billed ${formatUsd(result.totals.billedUsd)}` +
      (result.totals.savedUsd > 0 ? ` · saved ${formatUsd(result.totals.savedUsd)}` : ""),
  );
}
