import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  effectsOf,
  inspect,
  MemoryStore,
  objectSchema,
  run,
  RunStore,
  searchForkPoints,
  summarize,
  tool,
  type RunStore as Store,
  type Tool,
} from "../src/index.ts";
import { provider, tools as todaysTools } from "./fixtures/search-module.ts";

const MODULE = fileURLToPath(new URL("./fixtures/search-module.ts", import.meta.url));

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 6,
});

/** What the corpus said when the run was recorded. */
const recordedTool: Tool = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/**
 * Three steps: look "alpha" up, look "beta" up, answer with both.
 *
 * The module the searches below fork with declares the same tool against a
 * corpus that has since moved, so how far down the fork has to go is exactly
 * how far down a live tool call has to happen for the new corpus to reach the
 * answer. Fork at the last step and both results come out of the log; fork at
 * step 1 and the second lookup runs live.
 */
async function record(store: Store): Promise<void> {
  await run("explain alpha and beta", {
    agent,
    provider,
    tools: [recordedTool],
    store,
    runId: "baseline",
  });
}

const RECORDED_ANSWER = "definition of alpha | definition of beta";

test("the recorded run is the one the searches below re-enter", async () => {
  const store = new MemoryStore();
  await record(store);

  const parent = inspect("baseline", store);
  assert.equal(parent.status, "completed");
  assert.equal(parent.steps, 3);
  assert.equal(parent.output, RECORDED_ANSWER);
});

test("a search walks fork points downward and stops at the highest one that changes the answer", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", { provider, tools: todaysTools, store });

  assert.deepEqual(
    report.tried.map((t) => t.atStep),
    [2, 1],
    "highest first, and it stops as soon as one holds",
  );
  assert.equal(report.tried[0]?.matched, false, "at step 2 both lookups still come out of the log");
  assert.equal(report.tried[0]?.output, RECORDED_ANSWER);
  assert.equal(report.found?.atStep, 1);
  assert.equal(report.found?.output, "definition of alpha | today's definition of beta");
  assert.equal(report.stopped, undefined);
});

test("the fork points it did not need are the ones it did not pay for", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", { provider, tools: todaysTools, store });

  // Two forks, each replaying what it could: the whole search bills less than
  // the two runs it stands in for would have at list price.
  assert.equal(report.tried.length, 2);
  assert.ok(report.savedUsd > 0);
  assert.ok(report.billedUsd < report.costUsd);
  assert.equal(
    Number((report.billedUsd + report.savedUsd).toFixed(6)),
    Number(report.costUsd.toFixed(6)),
    "what the trials were billed plus what they replayed is what they were worth",
  );
});

test("every trial is a real run in the store, forked from the run searched", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", { provider, tools: todaysTools, store });

  for (const trial of report.tried) {
    const events = store.read(trial.runId);
    const summary = summarize(trial.runId, events);
    assert.equal(summary.forkedFrom?.runId, "baseline");
    assert.equal(summary.forkedFrom?.atStep, trial.atStep);
    assert.equal(summary.output, trial.output);
    assert.ok(effectsOf(events).some((e) => e.replayed) || trial.atStep === 0);
  }
});

test("a predicate is asked for instead, and the search goes as far down as it takes", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    until: (result) => result.output.includes("today's definition of alpha"),
  });

  assert.deepEqual(
    report.tried.map((t) => t.atStep),
    [2, 1, 0],
    "the first lookup only runs live at step 0",
  );
  assert.equal(report.found?.atStep, 0);
  assert.equal(report.found?.output, "today's definition of alpha | today's definition of beta");
});

test("a floor the search is not allowed past is reported rather than searched through", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    downTo: 2,
  });

  assert.deepEqual(report.tried.map((t) => t.atStep), [2]);
  assert.equal(report.found, undefined);
  assert.equal(report.downTo, 2);
});

test("a cap on forks ends the search and says what it did not try", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    maxForks: 1,
  });

  assert.deepEqual(report.tried.map((t) => t.atStep), [2]);
  assert.equal(report.found, undefined);
  assert.match(report.stopped ?? "", /capped at 1 fork: step 1 down to 0 was not tried/);
});

test("the search starts where it is told to, and finding it there is not finding it lower", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    from: 1,
  });

  assert.deepEqual(report.tried.map((t) => t.atStep), [1]);
  assert.equal(report.from, 1);
  assert.equal(report.found?.atStep, 1, "true, and it says nothing about step 2");
});

test("a fork point above the run's last step is not one, and the search clamps to it", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    from: 99,
  });

  // Forking at step 3 would replay the whole log and execute nothing, so it
  // could only ever hand back the recorded answer.
  assert.equal(report.from, 2);
  assert.equal(report.tried[0]?.atStep, 2);
});

test("a fork that did not answer is not an answer, whatever the predicate says", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    budget: { steps: 1 },
    until: () => true,
  });

  assert.equal(report.found, undefined, "every trial stopped on the budget without completing");
  assert.deepEqual(report.tried.map((t) => t.atStep), [2, 1, 0]);
  assert.deepEqual(
    [...new Set(report.tried.map((t) => t.status))],
    ["budget_exceeded"],
    "and each one is reported with the state it stopped in",
  );
});

test("a search carrying a counterfactual stops where the value stops being served", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    overrides: { "step:0#0:lookup": "nothing found" },
  });

  // Below step 1 the run consults the tool rather than the log, so the value
  // set for step 0 would be ignored — which `fork` refuses outright. The search
  // reports the floor instead of walking into the refusal.
  assert.equal(report.downTo, 1);
  assert.deepEqual(report.tried.map((t) => t.atStep), [2]);
  assert.equal(report.found?.atStep, 2, "the substitution alone already moves the answer");
  assert.equal(report.found?.output, "nothing found | definition of beta");
});

test("a search that reaches that floor says why it went no further", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    overrides: { "step:0#0:lookup": "nothing found" },
    until: () => false,
  });

  assert.deepEqual(report.tried.map((t) => t.atStep), [2, 1]);
  assert.equal(report.found, undefined);
  assert.match(report.stopped ?? "", /below step 1 the value set for "step:0#0:lookup"/);
});

test("a floor never reached is not reported as the reason a search that found something stopped", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    overrides: { "step:0#0:lookup": "nothing found" },
  });

  assert.ok(report.found !== undefined);
  assert.equal(report.stopped, undefined);
});

/* The command. */

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string } {
  let out = "";
  return {
    out: (s) => (out += s),
    err: (s) => (out += s),
    text: () => out.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

test("the CLI reports each fork as it makes it, and where the change took", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(["search", "baseline", "--dir", dir, "--module", MODULE], io);

  assert.equal(code, 0);
  const text = io.text();
  assert.match(text, /forking from step 2 down, until the answer is not the recorded one/);
  assert.match(text, /step 2\s+same/);
  assert.match(text, /step 1\s+differs/);
  assert.match(text, /found at step 1/);
  assert.match(text, /2 forks · \$/);
});

test("the CLI takes a pattern to search for, and names it in what it prints", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--until", "today's definition of alpha"],
    io,
  );

  assert.equal(code, 0);
  const text = io.text();
  assert.match(text, /matches \/today's definition of alpha\//);
  assert.match(text, /step 2\s+no match/);
  assert.match(text, /found at step 0/);
});

test("a search that finds nothing exits non-zero and says how far it looked", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--down-to", "2"],
    io,
  );

  assert.equal(code, 1);
  assert.match(io.text(), /not found: 1 fork down to step 2/);
});

test("a capped search says what it left untried", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--max-forks", "1"],
    io,
  );

  assert.equal(code, 1);
  assert.match(io.text(), /capped at 1 fork: step 1 down to 0 was not tried/);
});

test("search needs the module every one of its forks would execute with", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  assert.equal(await main(["search", "baseline", "--dir", dir], io), 1);
  assert.match(io.text(), /search needs --module/);
  assert.equal(await main(["search", "--dir", dir, "--module", MODULE], io), 1);
  assert.match(io.text(), /search needs a run id/);
});

test("search takes --at as a step to start from, not as an effect key", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--at", "step:1#0:lookup"],
    io,
  );

  assert.equal(code, 1);
  assert.match(io.text(), /--at \(search starts at a step\) takes a whole number/);
});
