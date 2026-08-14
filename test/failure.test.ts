import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  effectsOf,
  entryOf,
  fork,
  Journal,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  ReplayedFailure,
  resume,
  run,
  text,
  tool,
  toolUse,
  verifyEvents,
  type ModelRequest,
  type ModelResponse,
  type RetraceEvent,
  type ScriptedTurn,
  type Tool,
} from "../src/index.ts";

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

/**
 * A provider that throws on the nth live call and reads the script for the
 * rest. `liveCalls` counts every call that actually reached it, which is how a
 * replay proves it reached nothing.
 */
class FlakyProvider extends MockProvider {
  liveCalls = 0;
  private readonly failOn: number;
  private readonly thrown: Error;

  constructor(script: ScriptedTurn[], failOn: number, thrown: Error = overloaded()) {
    super(script);
    this.failOn = failOn;
    this.thrown = thrown;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.liveCalls++;
    if (this.liveCalls === this.failOn) throw this.thrown;
    return super.complete(request);
  }
}

function overloaded(): Error {
  const error = new Error("the model is overloaded, try again");
  error.name = "APIOverloadedError";
  return error;
}

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

/** Two tool turns, then an answer — with the model throwing on the second turn. */
function script() {
  return [
    { content: [toolUse("t1", "lookup", { term: "alpha" })] },
    { content: [toolUse("t2", "lookup", { term: "beta" })] },
    { content: [text("alpha and beta, explained")] },
  ];
}

/** A run whose model call throws on step 1, after one tool call has landed. */
async function recordFailure(store: MemoryStore, runId = "died") {
  const counter = countingTool();
  const provider = new FlakyProvider(script(), 2);
  const result = await run("explain alpha and beta", {
    agent,
    provider,
    tools: [counter.tool],
    store,
    runId,
  });
  return { result, provider, counter };
}

function effects(store: MemoryStore, runId: string) {
  return effectsOf(store.read(runId));
}

test("a model call that throws is recorded where its value would have gone", async () => {
  const store = new MemoryStore();
  const { result } = await recordFailure(store);

  assert.equal(result.status, "failed");
  assert.equal(result.error, "the model is overloaded, try again");

  const recorded = effects(store, "died");
  assert.deepEqual(
    recorded.map((e) => `${e.kind}:${e.key}`),
    ["model:step:0", "tool:step:0#0:lookup", "model:step:1"],
  );

  const threw = recorded.at(-1)!;
  assert.deepEqual(threw.failed, {
    name: "APIOverloadedError",
    message: "the model is overloaded, try again",
  });
  assert.equal(threw.value, null);
  assert.equal(threw.replayed, false);
  // Nothing was charged for a call that produced no tokens.
  assert.equal(
    store.read("died").filter((e) => e.type === "charge").length,
    1,
  );
});

test("a failed run replays into the same failure without reaching the model", async () => {
  const store = new MemoryStore();
  const original = await recordFailure(store);

  const counter = countingTool();
  // Scripted to succeed: if the replay reached it, the run would complete.
  const provider = new FlakyProvider([{ content: [text("a different answer")] }], 0);
  const again = await replay("died", { provider, tools: [counter.tool], store });

  assert.equal(provider.liveCalls, 0);
  assert.equal(counter.runs(), 0);
  assert.equal(again.status, original.result.status);
  assert.equal(again.error, original.result.error);
  assert.deepEqual(
    effects(store, again.runId).map((e) => [e.kind, e.key, e.replayed, e.failed?.message]),
    effects(store, "died").map((e) => [e.kind, e.key, true, e.failed?.message]),
  );
});

test("the journal hands a recorded throw back rather than raising it", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  // Handed back, because the caller has to get it into its own log before it
  // goes anywhere — a failure that threw its way past the loop's `emit` would
  // leave the replaying run unable to reproduce itself.
  const journal = new Journal(effects(store, "died").map(entryOf));
  await journal.effect("model", "step:0", () => assert.fail("step 0 should replay"));
  await journal.effect("tool", "step:0#0:lookup", () => assert.fail("the tool should replay"));
  const outcome = await journal.effect("model", "step:1", () => assert.fail("step 1 should replay"));

  assert.equal(outcome.replayed, true);
  assert.deepEqual(outcome.failed, {
    name: "APIOverloadedError",
    message: "the model is overloaded, try again",
  });

  const raised = outcome.thrown;
  assert.ok(raised instanceof ReplayedFailure);
  assert.equal(raised.message, "the model is overloaded, try again");
  assert.equal(raised.effectKey, "model:step:1");
  assert.equal(raised.recordedName, "APIOverloadedError");
});

test("a resume retries the call the run died on instead of replaying the failure", async () => {
  const store = new MemoryStore();
  const { counter } = await recordFailure(store);
  assert.equal(counter.runs(), 1);

  const again = countingTool();
  // The rest of the script, from the turn that threw.
  const provider = new MockProvider(script().slice(1));
  const finished = await resume("died", { provider, tools: [again.tool], store });

  assert.equal(finished.status, "completed");
  assert.equal(finished.output, "alpha and beta, explained");
  // Step 0's model call and tool call came out of the log; only the retried
  // call and what followed it executed.
  assert.equal(provider.callCount, 2);
  assert.equal(again.runs(), 1);

  const written = effects(store, finished.runId);
  assert.equal(written.filter((e) => e.replayed).length, 2);
  assert.equal(
    written.filter((e) => e.failed !== undefined).length,
    0,
    "the retried call succeeded, so nothing in the new log threw",
  );
});

test("a resume that fails again records the new failure, not the old one", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  const worse = new Error("still overloaded");
  worse.name = "APIOverloadedError";
  const provider = new FlakyProvider(script().slice(1), 1, worse);
  const finished = await resume("died", { provider, tools: [countingTool().tool], store });

  assert.equal(finished.status, "failed");
  assert.equal(finished.error, "still overloaded");
  assert.equal(provider.liveCalls, 1);
  assert.deepEqual(effects(store, finished.runId).at(-1)!.failed, {
    name: "APIOverloadedError",
    message: "still overloaded",
  });
});

test("a fork below the failure never reaches it", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  const counter = countingTool();
  const provider = new MockProvider([{ content: [text("answered without the second lookup")] }]);
  const forked = await fork("died", {
    provider,
    tools: [counter.tool],
    atStep: 1,
    store,
    agent: { system: "Answer from what you already have." },
  });

  assert.equal(forked.status, "completed");
  assert.equal(forked.output, "answered without the second lookup");
  assert.equal(counter.runs(), 0);
  assert.equal(effects(store, forked.runId).filter((e) => e.failed !== undefined).length, 0);
});

test("a fork through the failure fails the same way, for free", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  const provider = new FlakyProvider([{ content: [text("would have worked")] }], 0);
  const forked = await fork("died", {
    provider,
    tools: [countingTool().tool],
    atStep: 2,
    store,
  });

  assert.equal(forked.status, "failed");
  assert.equal(forked.error, "the model is overloaded, try again");
  assert.equal(provider.liveCalls, 0);
  assert.equal(forked.totals.billedUsd, 0);
});

test("an override hands the call that threw an answer it never gave", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  const counter = countingTool();
  const provider = new MockProvider([{ content: [text("both terms, explained")] }]);
  const asIf = await fork("died", {
    provider,
    tools: [counter.tool],
    atStep: 2,
    store,
    overrides: {
      "step:1": {
        model: "claude-opus-5",
        content: [toolUse("t2", "lookup", { term: "beta" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  });

  assert.equal(asIf.status, "completed");
  assert.equal(asIf.output, "both terms, explained");
  // The substituted turn asked for a lookup, and step 1 runs live from there.
  assert.equal(counter.runs(), 1);

  const substituted = effects(store, asIf.runId).find((e) => e.key === "step:1")!;
  assert.equal(substituted.overridden, true);
  assert.equal(
    substituted.failed,
    undefined,
    "an effect cannot both return the substituted value and have thrown",
  );
});

test("verify holds a log that carries on past a throw to be spliced", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  assert.equal(verifyEvents("died", store.read("died")).ok, true);

  // Move the failure up a slot: the log now records work after an effect that
  // ended the run, which the loop cannot produce.
  const events = store.read("died").map((e): RetraceEvent => ({ ...e }));
  const threw = events.find((e) => e.type === "effect" && e.key === "step:1")!;
  const first = events.find((e) => e.type === "effect" && e.key === "step:0")!;
  assert.equal(threw.type, "effect");
  assert.equal(first.type, "effect");
  if (threw.type !== "effect" || first.type !== "effect") return;
  first.failed = threw.failed;
  delete threw.failed;

  const report = verifyEvents("died", events);
  assert.equal(report.ok, false);
  assert.match(
    report.checks.find((c) => c.name === "shape")!.detail,
    /model:step:0 is recorded as having thrown, but the log records 2 more effects after it/,
  );
});

test("verify catches a fork whose prefix turns a recorded throw into an answer", async () => {
  const store = new MemoryStore();
  await recordFailure(store);

  const forked = await fork("died", {
    provider: new FlakyProvider([{ content: [text("x")] }], 0),
    tools: [countingTool().tool],
    atStep: 2,
    store,
  });
  assert.equal(verifyEvents(forked.runId, store.read(forked.runId), store).ok, true);

  // The fork's own log now claims step 1 came back with an answer. Its value
  // still matches the parent's — null — so only comparing values would miss it.
  const doctored = store.read(forked.runId).map((e): RetraceEvent => ({ ...e }));
  const replayedThrow = doctored.find((e) => e.type === "effect" && e.key === "step:1")!;
  if (replayedThrow.type !== "effect") return;
  delete replayedThrow.failed;

  const report = verifyEvents(forked.runId, doctored, store);
  assert.equal(report.ok, false);
  assert.match(
    report.checks.find((c) => c.name === "parent")!.detail,
    /model:step:1 was served a different value than died recorded for it/,
  );
});
