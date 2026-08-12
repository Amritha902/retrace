/**
 * The whole pitch in one file, with no API key and no network.
 *
 *   node examples/demo.ts
 *   npx retrace ls
 *   npx retrace diff demo-original demo-forked
 *
 * A scripted provider stands in for Claude so the numbers are reproducible.
 * Swap `MockProvider` for `AnthropicProvider` and nothing else changes.
 */
import {
  defineAgent,
  fork,
  formatUsd,
  MockProvider,
  objectSchema,
  replay,
  run,
  RunStore,
  text,
  tool,
  toolUse,
} from "../src/index.ts";

let searches = 0;
const search = tool({
  name: "search",
  description:
    "Search the corpus for a term. Call this whenever the answer depends on a fact you were not given.",
  inputSchema: objectSchema({ query: { type: "string", description: "What to look up" } }),
  run: (input: { query: string }) => {
    searches++;
    return `3 results for "${input.query}"`;
  },
});

const agent = defineAgent({
  name: "analyst",
  model: "claude-opus-5",
  system: "You are a research analyst. Cite what you searched.",
  maxSteps: 8,
});

// Four turns: three searches, then a written answer. Roughly the shape of a
// real research run, and the last turn is the one you always want to redo.
const transcript = [
  { content: [toolUse("s1", "search", { query: "market size" })] },
  { content: [toolUse("s2", "search", { query: "competitors" })] },
  { content: [toolUse("s3", "search", { query: "pricing" })] },
  { content: [text("The market is large, contested, and priced per seat.")] },
];
const heavyUsage = { inputTokens: 40_000, outputTokens: 1_200 };
const script = transcript.map((turn) => ({ ...turn, usage: heavyUsage }));

const store = new RunStore(".retrace");

console.log("1. record a fresh run\n");
const original = await run("Analyse the note-taking app market.", {
  agent,
  provider: new MockProvider(script),
  tools: [search],
  budget: { usd: 5 },
  store,
  runId: "demo-original",
});
console.log(`   ${original.status} in ${original.totals.steps} steps`);
console.log(`   ${searches} searches actually executed`);
console.log(`   billed ${formatUsd(original.totals.billedUsd)}\n`);

console.log("2. replay it — same answer, nothing touched\n");
searches = 0;
const replayed = await replay("demo-original", {
  provider: new MockProvider([]), // any model call would throw
  tools: [search],
  store,
  runId: "demo-replayed",
});
console.log(`   ${replayed.status}, output identical: ${replayed.output === original.output}`);
console.log(`   ${searches} searches executed`);
console.log(`   billed ${formatUsd(replayed.totals.billedUsd)}\n`);

console.log("3. fork at the last step with a different instruction\n");
searches = 0;
const forked = await fork("demo-original", {
  // Same token weight as the recorded steps, so the comparison is honest.
  provider: new MockProvider([
    { content: [text("Large market. Crowded. Per-seat pricing.")], usage: heavyUsage },
  ]),
  atStep: 3,
  tools: [search],
  agent: { system: "You are a research analyst. Answer in at most ten words." },
  store,
  runId: "demo-forked",
});
console.log(`   ${forked.status}: "${forked.output}"`);
console.log(`   ${searches} searches re-executed (the three from the prefix were free)`);
console.log(
  `   billed ${formatUsd(forked.totals.billedUsd)} instead of ` +
    `${formatUsd(forked.totals.costUsd)} — saved ${formatUsd(forked.totals.savedUsd)}\n`,
);

const saving = 1 - forked.totals.billedUsd / original.totals.billedUsd;
console.log(
  `Retrying the last step cost ${(saving * 100).toFixed(0)}% less than re-running from scratch.`,
);
console.log("\nNow try:  npx retrace show demo-forked   ·   npx retrace diff demo-original demo-forked");
