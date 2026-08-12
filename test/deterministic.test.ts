import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  deterministicEntries,
  effectsOf,
  fork,
  Journal,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  run,
  text,
  tool,
  toolUse,
  type RetraceEvent,
  type ToolContext,
} from "../src/index.ts";

const agent = defineAgent({ name: "stamper", model: "claude-opus-5", maxSteps: 6 });

/**
 * A tool that reads everything nondeterministic it can, and counts its own
 * executions so a replay can be proven not to have run it.
 */
function stampTool() {
  let runs = 0;
  return {
    runs: () => runs,
    tool: tool({
      name: "stamp",
      description: "Stamp a record with the current time and a fresh id. Call this to file a record.",
      inputSchema: objectSchema({ label: { type: "string" } }),
      run: async (input: { label: string }, ctx: ToolContext) => {
        runs++;
        const [at, id, roll] = [await ctx.now(), await ctx.uuid(), await ctx.random()];
        return `${input.label} at ${at} as ${id} roll ${roll}`;
      },
    }),
  };
}

function script() {
  return [
    { content: [toolUse("t1", "stamp", { label: "first" })] },
    { content: [toolUse("t2", "stamp", { label: "second" })] },
    { content: [text("filed")] },
  ];
}

function effects(events: readonly RetraceEvent[]) {
  return effectsOf(events);
}

test("a tool's clock, id and random reads land in the log", async () => {
  const store = new MemoryStore();
  const stamp = stampTool();

  const result = await run("file two records", {
    agent,
    provider: new MockProvider(script()),
    tools: [stamp.tool],
    store,
    runId: "stamped",
  });

  const nested = effects(result.events).filter((e) => e.key.includes("/"));
  assert.deepEqual(
    nested.map((e) => `${e.kind}:${e.key}`),
    [
      "clock:step:0#0:stamp/clock:0",
      "uuid:step:0#0:stamp/uuid:0",
      "random:step:0#0:stamp/random:0",
      "clock:step:1#0:stamp/clock:0",
      "uuid:step:1#0:stamp/uuid:0",
      "random:step:1#0:stamp/random:0",
    ],
  );
  assert.ok(nested.every((e) => !e.replayed));
  assert.equal(stamp.runs(), 2);
});

test("effect indices stay dense with nested effects in the sequence", async () => {
  const stamp = stampTool();
  const result = await run("file two records", {
    agent,
    provider: new MockProvider(script()),
    tools: [stamp.tool],
    store: new MemoryStore(),
  });

  assert.deepEqual(
    effects(result.events).map((e) => e.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  // step 0: model, tool, clock, uuid, random — the tool claims its slot before
  // the reads it makes, so the container sorts ahead of its contents.
  assert.deepEqual(
    effects(result.events)
      .slice(0, 5)
      .map((e) => e.kind),
    ["model", "tool", "clock", "uuid", "random"],
  );
});

test("a replayed tool does not re-stamp, and its nested effects do not derail the cursor", async () => {
  const store = new MemoryStore();
  const stamp = stampTool();
  const original = await run("file two records", {
    agent,
    provider: new MockProvider(script()),
    tools: [stamp.tool],
    store,
    runId: "stamped",
  });

  const replayStamp = stampTool();
  const provider = new MockProvider([]);
  const again = await replay("stamped", {
    provider,
    tools: [replayStamp.tool],
    store,
    runId: "stamped-again",
  });

  assert.equal(again.status, "completed");
  assert.equal(again.output, original.output);
  assert.equal(replayStamp.runs(), 0, "a replayed tool must not execute");
  assert.equal(provider.callCount, 0);
  assert.deepEqual(
    effects(again.events).map((e) => `${e.kind}:${e.key}`),
    effects(original.events).map((e) => `${e.kind}:${e.key}`),
  );
});

test("a fork that goes live past the log still gets the parent's time and ids", async () => {
  const store = new MemoryStore();
  const stamp = stampTool();
  const original = await run("file two records", {
    agent,
    provider: new MockProvider(script()),
    tools: [stamp.tool],
    store,
    runId: "stamped",
  });

  const forkStamp = stampTool();
  const forked = await fork("stamped", {
    // Only the live steps need scripting: step 0 comes out of the parent's log.
    provider: new MockProvider(script().slice(1)),
    tools: [forkStamp.tool],
    atStep: 1, // step 0 replays; step 1's tool executes for real
    store,
    runId: "stamped-fork",
  });

  assert.equal(forkStamp.runs(), 1, "only the live step's tool should have run");

  const before = effects(original.events).find((e) => e.key === "step:1#0:stamp");
  const after = effects(forked.events).find((e) => e.key === "step:1#0:stamp");
  assert.deepEqual(
    after?.value,
    before?.value,
    "a tool that ran live should still have produced the parent's stamps",
  );

  const liveStamps = effects(forked.events).filter((e) => e.key.startsWith("step:1#0:stamp/"));
  assert.equal(liveStamps.length, 3);
  assert.ok(
    liveStamps.every((e) => e.replayed),
    "the values came from the parent's log even though the tool executed",
  );
});

test("a fork that changes the run still stamps fresh values in slots the parent never had", async () => {
  const store = new MemoryStore();
  await run("file two records", {
    agent,
    provider: new MockProvider(script()),
    tools: [stampTool().tool],
    store,
    runId: "stamped",
  });

  // The fork asks for a third stamp, at a step the parent answered with text.
  const forked = await fork("stamped", {
    provider: new MockProvider([
      { content: [toolUse("t3", "stamp", { label: "third" })] },
      { content: [text("filed again")] },
    ]),
    tools: [stampTool().tool],
    atStep: 2,
    store,
    runId: "stamped-fork",
  });

  const fresh = effects(forked.events).filter((e) => e.key.startsWith("step:2#0:stamp/"));
  assert.equal(fresh.length, 3);
  assert.ok(
    fresh.every((e) => !e.replayed),
    "the parent has no step:2 tool call, so these have to be live",
  );
});

test("repeat reads of the same kind get their own slots", async () => {
  const twice = tool({
    name: "twice",
    description: "Read the clock twice. Call this to measure how long something took.",
    inputSchema: objectSchema({}),
    run: async (_input: unknown, ctx: ToolContext) => `${await ctx.now()}/${await ctx.now()}`,
  });

  const result = await run("measure", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "twice", {})] },
      { content: [text("measured")] },
    ]),
    tools: [twice],
    store: new MemoryStore(),
  });

  assert.deepEqual(
    effects(result.events)
      .filter((e) => e.kind === "clock")
      .map((e) => e.key),
    ["step:0#0:twice/clock:0", "step:0#0:twice/clock:1"],
  );
});

test("deterministic values resolve by key, not by position", async () => {
  const journal = new Journal(
    [],
    "strict",
    [{ index: 7, kind: "clock", key: "step:3#0:t/clock:0", value: 1_700_000_000_000 }],
  );

  // Several unrelated effects first: the recorded clock is at position 7 in its
  // own log and position 2 here, and it still resolves.
  await journal.effect("model", "step:0", () => "a");
  await journal.effect("tool", "step:0#0:t", () => "b");
  const stamped = await journal.deterministic("clock", "step:3#0:t/clock:0", () => Date.now());

  assert.equal(stamped.value, 1_700_000_000_000);
  assert.equal(stamped.replayed, true);
  assert.equal(stamped.index, 2);
});

test("an unrecorded deterministic key executes instead of diverging", async () => {
  const journal = new Journal([], "strict", [
    { index: 0, kind: "clock", key: "other", value: 1 },
  ]);

  const stamped = await journal.deterministic("uuid", "step:0#0:t/uuid:0", () => "fresh");

  assert.equal(stamped.value, "fresh");
  assert.equal(stamped.replayed, false);
});

test("deterministicEntries keeps every step, unlike the positional prefix", () => {
  const recorded = [
    { index: 0, step: 0, kind: "model", key: "step:0", value: 1 },
    { index: 1, step: 0, kind: "tool", key: "step:0#0:t", value: 2 },
    { index: 2, step: 0, kind: "clock", key: "step:0#0:t/clock:0", value: 3 },
    { index: 3, step: 5, kind: "uuid", key: "step:5#0:t/uuid:0", value: 4 },
    { index: 4, step: 5, kind: "random", key: "step:5#0:t/random:0", value: 5 },
  ];

  assert.deepEqual(
    deterministicEntries(recorded).map((e) => e.key),
    ["step:0#0:t/clock:0", "step:5#0:t/uuid:0", "step:5#0:t/random:0"],
  );
});
