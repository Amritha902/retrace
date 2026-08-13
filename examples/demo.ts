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
  overriddenEffects,
  replay,
  run,
  RunStore,
  staleEffects,
  text,
  tool,
  toolUse,
  verifyRun,
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
    `${formatUsd(forked.totals.costUsd)} — saved ${formatUsd(forked.totals.savedUsd)}`,
);
// The prefix is free, and it is also three answers given to the old
// instruction. Both are true, and the log says both.
console.log(
  `   ${staleEffects(forked.events).length} of those replayed steps answer the prompt you replaced\n`,
);

console.log("4. ask what the analyst would have said if the first search came back empty\n");
searches = 0;
const counterfactual = await fork("demo-original", {
  provider: new MockProvider([
    { content: [text("Market size unknown. Crowded. Per-seat pricing.")], usage: heavyUsage },
  ]),
  atStep: 3,
  tools: [search],
  overrides: { "step:0#0:search": "no results" },
  store,
  runId: "demo-counterfactual",
});
console.log(`   ${counterfactual.status}: "${counterfactual.output}"`);
console.log(`   ${searches} searches executed — the empty result came out of the log, replaced`);
// Steps 1 and 2 were recorded against the search that did return something, so
// they are still answering the world this fork just changed. Saying so is the
// difference between a counterfactual and a plausible-looking lie.
console.log(
  `   ${overriddenEffects(counterfactual.events).length} effect replaced, and ` +
    `${staleEffects(counterfactual.events).length} replayed steps now answer the old world\n`,
);

console.log("5. and none of the above is taken on trust\n");
// Every number printed so far came out of a log that also wrote the numbers.
// This reads the fork's log against the original's and checks the two agree,
// effect for effect — the one claim a fork's own log cannot make for itself.
for (const check of verifyRun("demo-forked", store).checks) {
  console.log(`   ${check.status.padEnd(6)} ${check.name.padEnd(12)} ${check.detail}`);
}
console.log();

const saving = 1 - forked.totals.billedUsd / original.totals.billedUsd;
console.log(
  `Retrying the last step cost ${(saving * 100).toFixed(0)}% less than re-running from scratch.`,
);
console.log(
  "\nNow try:  npx retrace show demo-forked   ·   npx retrace diff demo-original demo-forked" +
    "\n          npx retrace report demo-forked -o trace.html" +
    "\n          npx retrace verify demo-forked",
);
