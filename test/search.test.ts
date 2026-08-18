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
import {
  provider as wobbling,
  resetWobble,
  tools as recordedTools,
} from "./fixtures/wobble-module.ts";

const MODULE = fileURLToPath(new URL("./fixtures/search-module.ts", import.meta.url));
const WOBBLE = fileURLToPath(new URL("./fixtures/wobble-module.ts", import.meta.url));

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
  assert.match(io.text(), /not found: 1 fork point down to step 2/);
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

test("a fork point cut once is one draw, and the report says as much", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", { provider, tools: todaysTools, store });

  assert.equal(report.repeat, 1);
  for (const trial of report.tried) {
    assert.equal(trial.runs.length, 1);
    assert.equal(trial.unstable, false);
    assert.equal(
      trial.controlled,
      undefined,
      "one fork has nothing to be held against, so nothing is claimed",
    );
    assert.equal(trial.matches, trial.matched ? 1 : 0);
  }
});

test("a fork point cut several times holds only if every fork of it answers the same way", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    repeat: 3,
  });

  assert.equal(report.repeat, 3);
  assert.equal(report.found?.atStep, 1, "the same fork point one fork found, now asked three times");
  assert.equal(report.found?.matched, true);
  assert.equal(report.found?.matches, 3);
  assert.equal(report.found?.runs.length, 3);
  assert.deepEqual(
    report.found?.runs.map((r) => r.output),
    Array(3).fill("definition of alpha | today's definition of beta"),
    "a corpus that moved moves the answer every time, which is what makes this a finding",
  );
  assert.equal(report.unstable, undefined);
  assert.equal(report.tried[0]?.matches, 0, "and step 2 held nobody's attention three times over");
});

test("the forks of one fork point are held to the prefix they all replayed", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    repeat: 3,
  });

  const held = report.found?.controlled;
  assert.equal(held?.runs, 3);
  assert.equal(held?.claimed, 2, "step 0's model call and its lookup, below the fork point");
  assert.equal(held?.excused, 0);
  assert.equal(held?.ok, true);
  assert.equal(held?.contradiction, undefined);
});

test("every fork of a repeated fork point is a real run in the store", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    repeat: 3,
  });

  const ids = new Set<string>();
  for (const trial of report.tried) {
    for (const one of trial.runs) {
      assert.equal(ids.has(one.runId), false, "each fork gets a run id of its own");
      ids.add(one.runId);
      const summary = summarize(one.runId, store.read(one.runId));
      assert.equal(summary.forkedFrom?.runId, "baseline");
      assert.equal(summary.forkedFrom?.atStep, trial.atStep);
      assert.equal(summary.output, one.output);
    }
  }
  assert.equal(ids.size, report.tried.length * 3);
});

test("a fork point's cost is what all its forks cost, and the prefix is free for each", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    repeat: 3,
  });

  const found = report.found!;
  assert.equal(
    Number(found.billedUsd.toFixed(6)),
    Number(found.runs.reduce((sum, r) => sum + r.billedUsd, 0).toFixed(6)),
  );
  assert.ok(found.savedUsd > 0, "three forks of one point replayed three prefixes for nothing");
  assert.equal(
    Number((report.billedUsd + report.savedUsd).toFixed(6)),
    Number(report.costUsd.toFixed(6)),
  );
});

test("a model that answers two ways is a fork point that settles on neither", async () => {
  const store = new MemoryStore();
  await record(store);
  resetWobble();

  const report = await searchForkPoints("baseline", {
    provider: wobbling,
    tools: recordedTools,
    store,
    repeat: 2,
  });

  assert.equal(report.found, undefined, "nothing held, so there is no fork point to report");
  assert.equal(report.unstable?.atStep, 2, "the highest one that took some of the time");
  assert.equal(report.unstable?.matches, 1);
  assert.equal(report.unstable?.runs.length, 2);
  assert.equal(report.unstable?.matched, false);
  assert.deepEqual(
    report.tried.map((t) => t.atStep),
    [2, 1, 0],
    "an unstable fork point is not an answer, so the walk carries on below it",
  );
  assert.deepEqual(
    report.unstable?.runs.map((r) => r.matched),
    [false, true],
    "one fork answered what the run recorded and the next did not, with nothing changed",
  );
});

test("the forks of an unstable fork point still shared everything below it", async () => {
  const store = new MemoryStore();
  await record(store);
  resetWobble();

  const report = await searchForkPoints("baseline", {
    provider: wobbling,
    tools: recordedTools,
    store,
    repeat: 2,
  });

  // The whole claim of an unstable reading: the two forks cannot have differed
  // below the cut, so what moved, moved in the live tail.
  const held = report.unstable?.controlled;
  assert.equal(held?.ok, true);
  assert.equal(held?.runs, 2);
  assert.equal(held?.claimed, 4, "two steps of model call and lookup, below step 2");
});

test("a fork point has to be cut at least once", async () => {
  const store = new MemoryStore();
  await record(store);

  for (const repeat of [0, -1, 1.5]) {
    await assert.rejects(
      () => searchForkPoints("baseline", { provider, tools: todaysTools, store, repeat }),
      /repeat has to be a whole number of forks per fork point, at least 1/,
      `repeat ${repeat} is not a number of forks`,
    );
  }
});

test("the cap counts forks, not fork points, and never tries half of one", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await searchForkPoints("baseline", {
    provider,
    tools: todaysTools,
    store,
    repeat: 2,
    maxForks: 3,
  });

  assert.deepEqual(
    report.tried.map((t) => t.runs.length),
    [2],
    "a second fork point would take two more forks and only three were allowed",
  );
  assert.match(report.stopped ?? "", /capped at 3 forks: step 1 down to 0 was not tried/);
});

test("a search told to ask twice says what it asked and what held", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--repeat", "3"],
    io,
  );

  assert.equal(code, 0);
  const text = io.text();
  assert.match(text, /3 times over at each/);
  assert.match(text, /step 2\s+same\s+0 of 3/);
  assert.match(text, /step 1\s+differs\s+3 of 3/);
  assert.match(text, /found at step 1/);
  assert.match(text, /controlled: 6 effects replayed identically by the 3 forks of each fork point/);
  assert.match(text, /6 forks/, "two fork points, three forks each");
});

test("a search that finds only an unstable fork point says so and exits non-zero", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  resetWobble();
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", WOBBLE, "--repeat", "2"],
    io,
  );

  assert.equal(code, 1);
  const text = io.text();
  assert.match(text, /step 2\s+unstable 1 of 2/);
  assert.match(text, /unstable at step 2/);
  assert.match(text, /not the same twice, so it is not somewhere a change can be located/);
  assert.match(text, /not found: 3 fork points down to step 0/);
});

test("--repeat has to be a number of forks", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["search", "baseline", "--dir", dir, "--module", MODULE, "--repeat", "0"],
    io,
  );

  assert.equal(code, 1);
  assert.match(io.text(), /repeat has to be a whole number of forks per fork point, at least 1/);
});
