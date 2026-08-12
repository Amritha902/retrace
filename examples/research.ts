/**
 * The same flow against the real Claude API.
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node examples/research.ts "How do heat pumps work in cold climates?"
 *
 * Run it once to record. Then fork the last step to rewrite the answer without
 * paying for the research again:
 *
 *   npx retrace ls
 *   node examples/research.ts --fork <run-id> --at 3 --system "Answer in three bullets."
 */
import {
  AnthropicProvider,
  defineAgent,
  fork,
  formatUsd,
  objectSchema,
  run,
  RunStore,
  tool,
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

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are a careful technical writer. Look things up before you assert them.",
  maxSteps: 8,
  effort: "high",
});

const argv = process.argv.slice(2);
const provider = new AnthropicProvider();
const store = new RunStore();
const budget = { usd: 2, wallClockMs: 5 * 60_000 };

function flag(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

const forkOf = flag("fork");
const result = forkOf
  ? await fork(forkOf, {
      provider,
      tools: [lookup],
      atStep: Number(flag("at") ?? 0),
      budget,
      store,
      ...(flag("system") ? { agent: { system: flag("system") } } : {}),
      onEvent: report,
    })
  : await run(argv.filter((a) => !a.startsWith("--"))[0] ?? "How do heat pumps work in the cold?", {
      agent,
      provider,
      tools: [lookup],
      budget,
      store,
      onEvent: report,
    });

console.log(`\n${result.output}\n`);
console.log(
  `${result.runId} · ${result.status} · billed ${formatUsd(result.totals.billedUsd)}` +
    (result.totals.savedUsd > 0 ? ` · saved ${formatUsd(result.totals.savedUsd)}` : ""),
);

function report(event: { type: string; [k: string]: unknown }): void {
  if (event["type"] !== "effect") return;
  const tag = event["replayed"] ? "replayed" : "live";
  console.log(`  [${tag}] ${String(event["kind"])} ${String(event["key"])}`);
}
