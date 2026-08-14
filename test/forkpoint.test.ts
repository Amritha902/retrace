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
  fork,
  inspect,
  MemoryStore,
  MockProvider,
  objectSchema,
  renderReport,
  run,
  RunStore,
  staleFacets,
  summarize,
  text,
  tool,
  toolUse,
  verifyRun,
  type Tool,
} from "../src/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/agent-module.ts", import.meta.url));

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

/**
 * A tool whose answers can move underneath a recorded run, and which counts the
 * calls it really served. Between the two, a test can tell a replayed answer
 * from an answer the tool gave today.
 */
function corpus(): { tool: Tool; asked: () => string[]; move: (to: string) => void } {
  const asked: string[] = [];
  let edition = "first";
  return {
    asked: () => asked,
    move: (to) => void (edition = to),
    tool: tool({
      name: "lookup",
      description: "Look a term up. Call this when you need a fact you don't have.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => {
        asked.push(input.term);
        return `${edition} definition of ${input.term}`;
      },
    }),
  };
}

/**
 * One step that asks for two lookups, then an answer. Four effects: the model
 * turn, both tool calls, and the closing turn — which is the shape a fork point
 * inside a step has to cut through.
 */
const script = () => [
  {
    content: [toolUse("t1", "lookup", { term: "alpha" }), toolUse("t2", "lookup", { term: "beta" })],
  },
  { content: [text("alpha and beta, explained")] },
];

async function recordBaseline(store: MemoryStore) {
  const world = corpus();
  const provider = new MockProvider(script());
  const result = await run("explain alpha and beta", {
    agent,
    provider,
    tools: [world.tool],
    store,
    runId: "baseline",
  });
  return { result, world, provider };
}

test("forking at a tool call keeps the model turn that asked for it", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  assert.deepEqual(
    effectsOf(baseline.result.events).map((e) => e.key),
    ["step:0", "step:0#0:lookup", "step:0#1:lookup", "step:1"],
  );

  const world = corpus();
  world.move("second");
  const provider = new MockProvider([{ content: [text("beta has moved")] }]);

  const forked = await fork("baseline", {
    provider,
    atEffect: "step:0#1:lookup",
    tools: [world.tool],
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "completed");
  assert.equal(provider.callCount, 1, "step 0's model turn must come from the log");
  assert.deepEqual(world.asked(), ["beta"], "only the call at the fork point re-executes");
  assert.deepEqual(
    effectsOf(forked.events).map((e) => [e.key, e.replayed]),
    [
      ["step:0", true],
      ["step:0#0:lookup", true],
      ["step:0#1:lookup", false],
      ["step:1", false],
    ],
  );
});

test("the answer the live call gives is the one the run carries on with", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const world = corpus();
  world.move("second");
  const provider = new MockProvider([{ content: [text("done")] }]);
  await fork("baseline", {
    provider,
    atEffect: "step:0#1:lookup",
    tools: [world.tool],
    store,
    runId: "forked",
  });

  // The first lookup came out of the log, the second out of today's corpus —
  // which is the whole reason to cut a fork inside a step rather than above it.
  const results = provider.calls[0]?.messages.at(-1);
  assert.equal(results?.role, "user");
  assert.deepEqual(
    results?.content.map((b) => (b.type === "tool_result" ? b.content : b.type)),
    ["first definition of alpha", "second definition of beta"],
  );
});

test("a fork records the effect it went live at, and the step it is inside", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atEffect: "step:0#1:lookup",
    tools: [corpus().tool],
    store,
    runId: "forked",
  });

  assert.deepEqual(inspect("forked", store).forkedFrom, {
    runId: "baseline",
    atStep: 0,
    atEffect: "step:0#1:lookup",
  });
});

test("forking at a step's model call is forking at that step", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const byStep = await fork("baseline", {
    provider: new MockProvider([{ content: [text("ending")] }]),
    atStep: 1,
    tools: [corpus().tool],
    store,
    runId: "by-step",
  });
  const byEffect = await fork("baseline", {
    provider: new MockProvider([{ content: [text("ending")] }]),
    atEffect: "step:1",
    tools: [corpus().tool],
    store,
    runId: "by-effect",
  });

  // Two names for one boundary: the model call is the first effect of its step.
  assert.deepEqual(
    effectsOf(byEffect.events).map((e) => [e.key, e.replayed]),
    effectsOf(byStep.events).map((e) => [e.key, e.replayed]),
  );
  assert.equal(byEffect.totals.savedUsd, byStep.totals.savedUsd);
});

test("a fork point the log does not record is an error that names it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await assert.rejects(
    fork("baseline", {
      provider: new MockProvider([]),
      atEffect: "step:0#4:lookup",
      tools: [corpus().tool],
      store,
      runId: "nowhere",
    }),
    /records no effect "step:0#4:lookup"/,
  );
});

test("a clock read is not a fork point, and the error says what is", async () => {
  const store = new MemoryStore();
  const stamped = tool({
    name: "stamp",
    description: "Stamp the time. Call this when you need to record when something happened.",
    inputSchema: objectSchema({}),
    run: async (_input: unknown, ctx) => `at ${await ctx.now()}`,
  });
  await run("stamp it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", {})] },
      { content: [text("stamped")] },
    ]),
    tools: [stamped],
    store,
    runId: "stamped",
  });

  await assert.rejects(
    fork("stamped", {
      provider: new MockProvider([]),
      atEffect: "step:0#0:stamp/clock:0",
      tools: [stamped],
      store,
      runId: "at-a-clock",
    }),
    /is a clock read inside "step:0#0:stamp", not a call/,
  );
});

test("an override at the fork point is refused rather than quietly ignored", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  // step:0#0 is below the fork point and is served; step:0#1 is the fork point
  // itself, which executes, so nothing would be substituted for it.
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atEffect: "step:0#1:lookup",
    tools: [corpus().tool],
    overrides: { "step:0#0:lookup": "nothing found" },
    store,
    runId: "substituted",
  });
  assert.equal(forked.status, "completed");

  await assert.rejects(
    fork("baseline", {
      provider: new MockProvider([]),
      atEffect: "step:0#1:lookup",
      tools: [corpus().tool],
      overrides: { "step:0#1:lookup": "nothing found" },
      store,
      runId: "inert",
    }),
    /which this fork runs live/,
  );
});

test("a replayed call below an effect fork point still says what moved above it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atEffect: "step:0#1:lookup",
    tools: [corpus().tool],
    agent: { system: "Answer in one sentence." },
    store,
    runId: "forked",
  });

  // The prompt this fork was given is not the one step 0's model call answered,
  // and cutting the fork mid-step does not make that any less true.
  assert.deepEqual(staleFacets(forked.events), ["system"]);
});

test("verify holds a mid-step fork to its parent and to its own fork point", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atEffect: "step:0#1:lookup",
    tools: [corpus().tool],
    store,
    runId: "forked",
  });

  const report = verifyRun("forked", store);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.match(
    report.checks.find((c) => c.name === "parent")?.detail ?? "",
    /2 replayed effects are baseline's, value for value/,
  );
});

/** A store directory that cleans itself up when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-forkpoint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string; errors(): string } {
  let out = "";
  let err = "";
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    text: () => strip(out),
    errors: () => strip(err),
  };
}

test("--at takes an effect key, and show says the run came from one", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [corpus().tool],
    store,
    runId: "baseline",
  });

  const forking = capture();
  const code = await main(
    ["fork", "baseline", "--at", "step:0#1:lookup", "--dir", dir, "--module", FIXTURE],
    forking,
  );

  assert.equal(code, 0, forking.errors());
  assert.match(forking.text(), /everything recorded before step:0#1:lookup replays/);
  assert.match(forking.text(), /replayed {2}model {2}step:0 /);
  assert.match(forking.text(), /live {6}tool {3}step:0#1:lookup/);

  const forked = store.list().find((id) => id !== "baseline")!;
  const shown = capture();
  assert.equal(await main(["show", forked, "--dir", dir], shown), 0);
  assert.match(shown.text(), /forked from baseline at step:0#1:lookup/);

  const events = store.read(forked);
  assert.match(
    renderReport(summarize(forked, events), events),
    /forked from <span class="mono">baseline<\/span> at <span class="mono">step:0#1:lookup<\/span>, inside step 0/,
  );
});

test("verify catches a log that replayed past the fork point it claims", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atStep: 1,
    tools: [corpus().tool],
    store,
    runId: "forked",
  });

  // The run replayed all of step 0, then claims it was only meant to replay up
  // to the first of its two lookups. One of those two statements is false.
  for (const event of store.read("forked")) {
    store.append(
      "doctored",
      event.type === "run.started" && event.forkedFrom
        ? { ...event, forkedFrom: { ...event.forkedFrom, atStep: 0, atEffect: "step:0#1:lookup" } }
        : event,
    );
  }

  const report = verifyRun("doctored", store);
  assert.equal(report.ok, false);
  assert.match(
    report.checks.find((c) => c.name === "parent")?.detail ?? "",
    /tool:step:0#1:lookup was replayed, and this fork was meant to run live from step:0#1:lookup/,
  );
});

test("verify refuses a fork point its parent has no effect for", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("x")] }]),
    atStep: 1,
    tools: [corpus().tool],
    store,
    runId: "forked",
  });

  for (const event of store.read("forked")) {
    store.append(
      "doctored",
      event.type === "run.started" && event.forkedFrom
        ? { ...event, forkedFrom: { ...event.forkedFrom, atEffect: "step:9#0:lookup" } }
        : event,
    );
  }

  const report = verifyRun("doctored", store);
  assert.equal(report.ok, false);
  assert.match(
    report.checks.find((c) => c.name === "parent")?.detail ?? "",
    /says it went live at step:9#0:lookup, and baseline records no such effect/,
  );
});
