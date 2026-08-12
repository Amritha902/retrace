import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  DivergenceError,
  effectsOf,
  fork,
  inspect,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  run,
  text,
  tool,
  toolUse,
  type Tool,
} from "../src/index.ts";

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

/** A tool that counts how many times it really ran, so replays can be proven free. */
function countingTool(): { tool: Tool; runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    tool: tool({
      name: "lookup",
      description: "Look a term up. Call this when you need a fact you don't have.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => {
        runs++;
        return `definition of ${input.term}`;
      },
    }),
  };
}

/** Three model turns: two tool calls, then an answer. */
function script() {
  return [
    { content: [toolUse("t1", "lookup", { term: "alpha" })] },
    { content: [toolUse("t2", "lookup", { term: "beta" })] },
    { content: [text("alpha and beta, explained")] },
  ];
}

async function recordBaseline(store: MemoryStore) {
  const counter = countingTool();
  const provider = new MockProvider(script());
  const result = await run("explain alpha and beta", {
    agent,
    provider,
    tools: [counter.tool],
    store,
    runId: "baseline",
  });
  return { result, counter, provider };
}

test("a full replay reaches neither the model nor the tools", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  assert.equal(baseline.result.status, "completed");
  assert.equal(baseline.counter.runs(), 2);

  const counter = countingTool();
  const provider = new MockProvider([]); // any call would throw "ran out of script"

  const replayed = await replay("baseline", {
    provider,
    tools: [counter.tool],
    store,
    runId: "replayed",
  });

  assert.equal(provider.callCount, 0, "replay must not call the model");
  assert.equal(counter.runs(), 0, "replay must not re-run tools");
  assert.equal(replayed.status, baseline.result.status);
  assert.equal(replayed.output, baseline.result.output);
});

test("a replay reproduces the original effect sequence exactly", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [countingTool().tool],
    store,
    runId: "replayed",
  });

  const original = effectsOf(baseline.result.events).map((e) => ({
    kind: e.kind,
    key: e.key,
    value: e.value,
  }));
  const again = effectsOf(replayed.events).map((e) => ({
    kind: e.kind,
    key: e.key,
    value: e.value,
  }));

  assert.deepEqual(again, original);
});

test("replayed steps cost nothing, and the saving is reported", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  assert.ok(baseline.result.totals.billedUsd > 0);
  assert.equal(baseline.result.totals.savedUsd, 0);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [countingTool().tool],
    store,
    runId: "replayed",
  });

  assert.equal(replayed.totals.billedUsd, 0, "a replay spends no money");
  assert.equal(replayed.totals.costUsd, baseline.result.totals.costUsd);
  assert.equal(replayed.totals.savedUsd, baseline.result.totals.costUsd);
});

test("forking at step 2 replays the prefix and executes only what follows", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const counter = countingTool();
  // Only the final turn is scripted: steps 0 and 1 must come from the log.
  const provider = new MockProvider([{ content: [text("a different ending")] }]);

  const forked = await fork("baseline", {
    provider,
    atStep: 2,
    tools: [counter.tool],
    agent: { system: "Answer in one sentence." },
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "completed");
  assert.equal(forked.output, "a different ending");
  assert.equal(provider.callCount, 1, "steps 0 and 1 must not reach the model");
  assert.equal(counter.runs(), 0, "the replayed prefix must not re-run tools");

  const live = effectsOf(forked.events).filter((e) => !e.replayed);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.key, "step:2");

  // The changed system prompt reaches the model on the first live call.
  assert.equal(provider.calls[0]?.system, "Answer in one sentence.");
});

test("a fork records where it came from", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atStep: 2,
    tools: [countingTool().tool],
    store,
    runId: "forked",
  });

  assert.deepEqual(inspect("forked", store).forkedFrom, { runId: "baseline", atStep: 2 });
});

test("forking at step 0 keeps the configuration but replays nothing", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const counter = countingTool();
  const provider = new MockProvider(script());
  const forked = await fork("baseline", {
    provider,
    atStep: 0,
    tools: [counter.tool],
    store,
    runId: "fresh",
  });

  assert.equal(provider.callCount, 3);
  assert.equal(counter.runs(), 2);
  assert.equal(forked.totals.savedUsd, 0);
});

test("replaying does not need the tools to be registered", async () => {
  // The recorded results are in the log, so a replay is useful even from a
  // process that no longer has the tool implementations available.
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [],
    store,
    runId: "toolless",
  });

  assert.equal(replayed.status, "completed");
  assert.equal(replayed.output, baseline.result.output);
  assert.equal(replayed.totals.toolCalls, 2);
});

/**
 * Drop one effect from a recorded log, the way a crash mid-step or a hand-edit
 * would. Everything after the hole is now misaligned with the run that produced
 * it — which is exactly what the divergence check exists to catch.
 */
function writeLogWithHole(store: MemoryStore, from: string, to: string, dropIndex: number): void {
  for (const event of store.read(from)) {
    if (event.type === "effect" && event.index === dropIndex) continue;
    store.append(to, event);
  }
}

test("forking from a log with a hole in it fails loudly by default", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  // Effect 2 is step 1's model call; without it the journal offers step 1's
  // tool result where the loop expects a model response.
  writeLogWithHole(store, "baseline", "holed", 2);

  const forked = await fork("holed", {
    provider: new MockProvider([]),
    atStep: 3,
    tools: [countingTool().tool],
    store,
    runId: "diverged",
  });

  assert.equal(forked.status, "failed");
  assert.match(forked.error ?? "", /diverged from its parent/);
  assert.match(forked.error ?? "", /effect 2/);
});

test('onDivergence "live" resumes execution at the point of disagreement', async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  writeLogWithHole(store, "baseline", "holed", 2);

  const counter = countingTool();
  const provider = new MockProvider([{ content: [text("carried on live")] }]);
  const forked = await fork("holed", {
    provider,
    atStep: 3,
    tools: [counter.tool],
    onDivergence: "live",
    store,
    runId: "diverged-live",
  });

  assert.equal(forked.status, "completed");
  assert.equal(forked.output, "carried on live");
  assert.equal(provider.callCount, 1, "only the diverged step reaches the model");

  const effects = effectsOf(forked.events);
  assert.deepEqual(
    effects.map((e) => e.replayed),
    [true, true, false],
    "the intact prefix replays; everything from the hole onward runs live",
  );
});

test("DivergenceError names the effect that disagreed", () => {
  const error = new DivergenceError(3, "model:step:1", "tool:step:0#0:lookup");
  assert.match(error.message, /effect 3/);
  assert.match(error.message, /model:step:1/);
  assert.match(error.message, /tool:step:0#0:lookup/);
});
