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
  overriddenEffects,
  renderReport,
  replay,
  run,
  RunStore,
  summarize,
  text,
  tool,
  toolUse,
  type RetraceEvent,
  type ToolContext,
} from "../src/index.ts";

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 6,
});

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/** A tool that reads the clock, so a run has a deterministic effect to replace. */
const stamp = tool({
  name: "stamp",
  description: "Stamp the current time. Call this to record when something happened.",
  inputSchema: objectSchema({}),
  run: async (_input: unknown, ctx: ToolContext) => `at ${await ctx.now()}`,
});

/** Three lookups, then an answer: four steps, seven effects. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [toolUse("t3", "lookup", { term: "gamma" })] },
  { content: [text("alpha, beta and gamma explained")] },
];

async function recordBaseline(store: MemoryStore) {
  return run("explain alpha, beta and gamma", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
}

/** The text of the last tool result the model was shown, in a given request. */
function lastToolResults(provider: MockProvider, call = 0): string[] {
  const request = provider.calls[call];
  assert.ok(request, `the provider was never called ${call + 1} time(s)`);
  const last = request.messages[request.messages.length - 1];
  assert.ok(last && last.role === "user", "the last message should be tool results");
  return last.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
}

function models(events: readonly RetraceEvent[]) {
  return effectsOf(events)
    .filter((e) => e.kind === "model")
    .map((e) => ({ key: e.key, replayed: e.replayed, stale: e.stale === true }));
}

test("a fork can hand a live step a result the tool never returned", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const provider = new MockProvider([{ content: [text("gamma turned up nothing")] }]);
  const forked = await fork("baseline", {
    provider,
    atStep: 3,
    tools: [lookup],
    overrides: { "step:2#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  assert.equal(provider.callCount, 1, "only step 3 should reach the model");
  assert.deepEqual(
    lastToolResults(provider),
    ["no results"],
    "the live step must see the value that was set, not the recorded one",
  );
  assert.equal(forked.output, "gamma turned up nothing");
});

test("the log holds the value the run saw, and says it is not the recorded one", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("done")] }]),
    atStep: 3,
    tools: [lookup],
    overrides: { "step:2#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  const set = overriddenEffects(forked.events);
  assert.equal(set.length, 1);
  assert.equal(set[0]?.key, "step:2#0:lookup");
  assert.equal(set[0]?.replayed, true, "an overridden effect is still served from the log");
  assert.deepEqual(set[0]?.value, { content: "no results", isError: false });

  const recorded = effectsOf(baseline.events).find((e) => e.key === "step:2#0:lookup");
  assert.deepEqual(
    recorded?.value,
    { content: "definition of gamma", isError: false },
    "the parent's log is untouched by a fork that reads it",
  );

  assert.deepEqual(inspect("counterfactual", store).forkedFrom, {
    runId: "baseline",
    atStep: 3,
    overrides: ["step:2#0:lookup"],
  });
});

test("every replayed step that depended on a changed value comes back stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("done")] }]),
    atStep: 3,
    tools: [lookup],
    // The first tool call of the run: steps 1 and 2 were both recorded against a
    // conversation containing its original result.
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  assert.deepEqual(models(forked.events), [
    // Step 0's request was built before the tool ran, so changing the result
    // cannot have changed the question it answered.
    { key: "step:0", replayed: true, stale: false },
    { key: "step:1", replayed: true, stale: true },
    { key: "step:2", replayed: true, stale: true },
    { key: "step:3", replayed: false, stale: false },
  ]);
});

test("a fork that changes nothing has nothing set and nothing stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("done")] }]),
    atStep: 3,
    tools: [lookup],
    store,
    runId: "plain",
  });

  assert.equal(overriddenEffects(forked.events).length, 0);
  assert.deepEqual(
    models(forked.events).filter((m) => m.stale),
    [],
  );
});

test("an override naming an effect the log does not hold is refused", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await assert.rejects(
    fork("baseline", {
      provider: new MockProvider([]),
      atStep: 3,
      tools: [lookup],
      overrides: { "step:2#0:search": "no results" },
      store,
    }),
    /records no effect "step:2#0:search"/,
  );
});

test("an override at a step the fork runs live is refused rather than ignored", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await assert.rejects(
    fork("baseline", {
      provider: new MockProvider([]),
      // Step 2 executes for real here, so its tool call is never read from the log.
      atStep: 2,
      tools: [lookup],
      overrides: { "step:2#0:lookup": "no results" },
      store,
    }),
    /is at step 2, which this fork runs live.*Fork at step 3/s,
  );
});

test("a tool result set as text keeps the outcome's shape; an object replaces it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("done")] }]),
    atStep: 3,
    tools: [lookup],
    overrides: {
      "step:0#0:lookup": "plain text",
      "step:1#0:lookup": { content: "the lookup service is down", isError: true },
    },
    store,
    runId: "counterfactual",
  });

  const byKey = new Map(effectsOf(forked.events).map((e) => [e.key, e.value]));
  assert.deepEqual(byKey.get("step:0#0:lookup"), { content: "plain text", isError: false });
  assert.deepEqual(byKey.get("step:1#0:lookup"), {
    content: "the lookup service is down",
    isError: true,
  });
});

test("a clock a tool read can be set, and a live tool reads the set value", async () => {
  const store = new MemoryStore();
  await run("stamp it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("s1", "stamp", {})] },
      { content: [toolUse("s2", "stamp", {})] },
      { content: [text("stamped twice")] },
    ]),
    tools: [stamp],
    store,
    runId: "stamped",
  });

  const provider = new MockProvider([
    { content: [toolUse("s2", "stamp", {})] },
    { content: [text("stamped again")] },
  ]);
  // Step 1 runs live, so its tool really executes — and reads the clock slot
  // the parent filled, which is what the override replaces.
  const forked = await fork("stamped", {
    provider,
    atStep: 1,
    tools: [stamp],
    overrides: { "step:1#0:stamp/clock:0": 1_700_000_000_000 },
    store,
    runId: "counterfactual",
  });

  assert.deepEqual(lastToolResults(provider, 1), ["at 1700000000000"]);
  const read = effectsOf(forked.events).find((e) => e.key === "step:1#0:stamp/clock:0");
  assert.equal(read?.overridden, true);
  assert.equal(forked.output, "stamped again");
});

test("a replay can be given an override too, and every step below it goes stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [lookup],
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  assert.equal(replayed.output, "alpha, beta and gamma explained");
  assert.deepEqual(models(replayed.events), [
    { key: "step:0", replayed: true, stale: false },
    { key: "step:1", replayed: true, stale: true },
    { key: "step:2", replayed: true, stale: true },
    { key: "step:3", replayed: true, stale: true },
  ]);
});

test("the report marks a set value and says why the page has one", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("done")] }]),
    atStep: 3,
    tools: [lookup],
    overrides: { "step:2#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  const html = renderReport(summarize("counterfactual", forked.events), forked.events);
  assert.match(html, /badge set/, "the overridden effect carries a badge");
  assert.match(html, /1 of them did not come back as recorded/);
  assert.match(html, /no results/, "the value the run actually saw is on the page");
  assert.match(html, /--set:#/, "the badge has a colour in both themes");
});

// ------------------------------------------------------------------- the CLI

const FIXTURE = fileURLToPath(new URL("./fixtures/agent-module.ts", import.meta.url));

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-set-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string; errors(): string } {
  let out = "";
  let err = "";
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    text: () => strip(out),
    errors: () => strip(err),
  };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("fork --set replaces a recorded result from the command line", async (t) => {
  const dir = tempDir(t);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "alpha" })] },
      { content: [text("alpha, explained")] },
    ]),
    tools: [lookup],
    store: new RunStore(dir),
    runId: "baseline",
  });

  const io = capture();
  const code = await main(
    ["fork", "baseline", "--at", "1", "--set", "step:0#0:lookup=nothing found", "--dir", dir, "--module", FIXTURE],
    io,
  );

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /replayed\s+tool\s+step:0#0:lookup\s+set/);
  assert.match(io.text(), /1 effect served a value you set/);
  assert.match(io.text(), /→ nothing found/, "the timeline shows what the step was given");

  const forkId = new RunStore(dir).list().find((id) => id.startsWith("fork_"));
  assert.ok(forkId, "the fork should have been written to the store");
  const shown = capture();
  assert.equal(await main(["show", forkId, "--dir", dir], shown), 0, shown.errors());
  assert.match(shown.text(), /forked from baseline at step 1, with step:0#0:lookup set/);
});

test("--set is repeatable, and a malformed one says what it takes", async (t) => {
  const dir = tempDir(t);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "alpha" })] },
      { content: [toolUse("t2", "lookup", { term: "beta" })] },
      { content: [text("both, explained")] },
    ]),
    tools: [lookup],
    store: new RunStore(dir),
    runId: "baseline",
  });

  const io = capture();
  const code = await main(
    [
      "replay",
      "baseline",
      "--set",
      "step:0#0:lookup=one",
      "--set",
      "step:1#0:lookup=two",
      "--dir",
      dir,
    ],
    io,
  );
  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /2 effects served a value you set/);

  const bad = capture();
  assert.equal(await main(["replay", "baseline", "--set", "nonsense", "--dir", dir], bad), 1);
  assert.match(bad.errors(), /--set takes "<effect-key>=<value>"/);
});
