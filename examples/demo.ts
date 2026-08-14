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
  compareRuns,
  defineAgent,
  explainStale,
  fork,
  formatUsd,
  MockProvider,
  objectSchema,
  overriddenEffects,
  recheckRun,
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
// instruction. Both are true, and the log says both. What the instruction moved
// *to* is not in this log — a digest is all it keeps — but it is in the one this
// run was forked from, which is the same log the free prefix came out of.
console.log(
  `   ${staleEffects(forked.events).length} of those replayed steps answer the prompt you replaced`,
);
const moved = explainStale("demo-forked", store).changes;
console.log(`   ${moved.map((c) => c.facet).join(", ")} moved, and nothing else:`);
for (const change of moved) {
  console.log(`     - ${change.before}`);
  console.log(`     + ${change.after}`);
}
console.log();

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
// That check needs the original in the store. The two forks above need only
// each other: they replayed the same prefix out of the same log, so they cannot
// hold different values across it wherever demo-original happens to be.
const siblings = compareRuns("demo-forked", "demo-counterfactual", store);
console.log(
  `\n   and without demo-original at all: ${siblings.claimed} effects both forks replayed ` +
    `from it agree, ${siblings.excused} of them substituted on purpose\n`,
);

console.log("6. …and the answers it replayed for free are still the answers\n");
// Step 5 held the log to the log. This holds it to the world: the three
// searches the fork got for nothing are put to the tool again, with the
// queries the model asked at the time, and compared to what the log holds.
searches = 0;
const rechecked = await recheckRun("demo-forked", { tools: [search], store });
for (const call of rechecked.calls) {
  console.log(`   ${call.status.padEnd(6)} ${call.key.padEnd(16)} ${call.recorded.content}`);
}
console.log(
  `\n   ${searches} searches re-executed; the free prefix is still true, so it is still ` +
    `worth having\n`,
);

const saving = 1 - forked.totals.billedUsd / original.totals.billedUsd;
console.log(
  `Retrying the last step cost ${(saving * 100).toFixed(0)}% less than re-running from scratch.`,
);
console.log(
  "\nNow try:  npx retrace show demo-forked   ·   npx retrace diff demo-original demo-forked" +
    "\n          npx retrace report demo-forked -o trace.html" +
    "\n          npx retrace verify demo-forked   ·   npx retrace stale demo-forked",
);
