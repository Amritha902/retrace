import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ambientEffects,
  defineAgent,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  run,
  text,
  tool,
  toolUse,
  verifyEvents,
  type ToolContext,
} from "../src/index.ts";

const agent = defineAgent({ name: "stamper", model: "claude-opus-5", maxSteps: 6 });

/** A tool that reaches for whatever `reach` names, instead of asking `ctx`. */
function reachingTool(reach: (ctx: ToolContext) => Promise<string> | string) {
  return tool({
    name: "stamp",
    description: "Stamp a record. Call this to file a record.",
    inputSchema: objectSchema({ label: { type: "string" } }),
    run: (input: { label: string }, ctx: ToolContext) =>
      Promise.resolve(reach(ctx)).then((stamped) => `${input.label} ${stamped}`),
  });
}

function script(calls = 1) {
  return [
    ...Array.from({ length: calls }, (_, i) => ({
      content: [toolUse(`t${i}`, "stamp", { label: `record ${i}` })],
    })),
    { content: [text("filed")] },
  ];
}

async function recordWith(
  reach: (ctx: ToolContext) => Promise<string> | string,
  options: { runId?: string; store?: MemoryStore; parallelTools?: boolean; calls?: number } = {},
) {
  const store = options.store ?? new MemoryStore();
  const result = await run("file a record", {
    agent: { ...agent, ...(options.parallelTools ? { parallelTools: true } : {}) },
    provider: new MockProvider(script(options.calls ?? 1)),
    tools: [reachingTool(reach)],
    store,
    runId: options.runId ?? "stamped",
  });
  return { store, result };
}

test("a tool that reads the clock through ctx is not marked", async () => {
  const { result } = await recordWith(async (ctx) => `at ${await ctx.now()}`);

  assert.deepEqual(ambientEffects(result.events), []);
  assert.equal(
    verifyEvents("stamped", result.events).checks.find((c) => c.name === "ambient")?.status,
    "ok",
  );
});

test("a tool that calls Date.now() is marked with what it read", async () => {
  const { result } = await recordWith(() => `at ${Date.now()}`);

  const marked = ambientEffects(result.events);
  assert.deepEqual(
    marked.map((e) => [e.key, e.ambient]),
    [["step:0#0:stamp", ["clock"]]],
  );
});

test("new Date() is a clock read; new Date(ms) is arithmetic", async () => {
  const { result: fromClock } = await recordWith(() => new Date().toISOString());
  assert.deepEqual(ambientEffects(fromClock.events).map((e) => e.ambient), [["clock"]]);

  const { result: fromValue } = await recordWith(() => new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(ambientEffects(fromValue.events), []);
});

test("Math.random() and crypto.randomUUID() are marked too, once each", async () => {
  const { result } = await recordWith(
    () => `${Math.random()} ${Math.random()} ${globalThis.crypto.randomUUID()}`,
  );

  assert.deepEqual(ambientEffects(result.events).map((e) => e.ambient), [["random", "uuid"]]);
});

test("the wrappers come down again, and leave the globals as they found them", async () => {
  const date = globalThis.Date;
  const now = Date.now;
  const random = Math.random;
  const uuid = globalThis.crypto.randomUUID;

  await recordWith(() => `${Date.now()} ${Math.random()} ${globalThis.crypto.randomUUID()}`);

  assert.equal(globalThis.Date, date);
  assert.equal(Date.now, now);
  assert.equal(Math.random, random);
  assert.equal(globalThis.crypto.randomUUID, uuid);
});

test("a Date made outside the window still answers instanceof inside it", async () => {
  const before = new Date(0);
  let seen: boolean | undefined;

  await recordWith(() => {
    seen = before instanceof Date && new Date() instanceof Date;
    return "checked";
  });

  assert.equal(seen, true);
});

test("the loop's own reads are not a tool's: ctx.now and ctx.random stay unwatched", async () => {
  const { result } = await recordWith(
    async (ctx) => `${await ctx.now()} ${await ctx.random()} ${await ctx.uuid()}`,
  );

  assert.deepEqual(ambientEffects(result.events), []);
  // The reads themselves are still journaled — this is about who is watching,
  // not about whether the journal covers them.
  assert.equal(effectsOf(result.events).filter((e) => e.key.includes("/")).length, 3);
});

test("randomUUID imported from node:crypto is out of reach, and the log does not pretend otherwise", async () => {
  const { result } = await recordWith(() => randomUUID());

  assert.deepEqual(ambientEffects(result.events), []);
});

test("a parallel batch marks the call that reached, and not the one beside it", async () => {
  const store = new MemoryStore();
  let call = 0;
  const stamp = tool({
    name: "stamp",
    description: "Stamp a record. Call this to file a record.",
    inputSchema: objectSchema({ label: { type: "string" } }),
    run: async (input: { label: string }) => {
      const mine = call++;
      await new Promise((resolve) => setTimeout(resolve, mine === 0 ? 10 : 0));
      return mine === 0 ? `${input.label} at ${Date.now()}` : `${input.label} steady`;
    },
  });

  const result = await run("file two records", {
    agent: { ...agent, parallelTools: true },
    provider: new MockProvider([
      { content: [toolUse("a", "stamp", { label: "one" }), toolUse("b", "stamp", { label: "two" })] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store,
    runId: "batched",
  });

  assert.deepEqual(
    ambientEffects(result.events).map((e) => [e.key, e.ambient]),
    [["step:0#0:stamp", ["clock"]]],
  );
});

test("a replay reproduces the marking without re-running the tool", async () => {
  const { store, result } = await recordWith(() => `at ${Date.now()}`);

  let ran = 0;
  const again = await replay("stamped", {
    provider: new MockProvider([]),
    tools: [
      reachingTool(() => {
        ran++;
        return "should not run";
      }),
    ],
    store,
    runId: "stamped-again",
  });

  assert.equal(ran, 0);
  assert.deepEqual(
    ambientEffects(again.events).map((e) => [e.key, e.ambient]),
    ambientEffects(result.events).map((e) => [e.key, e.ambient]),
  );
});

test("a fork replaying the call carries the warning; forking past it drops it", async () => {
  const { store } = await recordWith(() => `at ${Date.now()}`, { calls: 2 });

  const replayed = await fork("stamped", {
    provider: new MockProvider([{ content: [text("filed")] }]),
    tools: [reachingTool((ctx) => ctx.now().then(String))],
    store,
    runId: "fork-below",
    atStep: 2,
  });
  assert.deepEqual(
    ambientEffects(replayed.events).map((e) => e.key),
    ["step:0#0:stamp", "step:1#0:stamp"],
  );

  // The same fork with a tool that asks `ctx` instead: the call it re-runs is
  // clean, and the one it still replays is not.
  const live = await fork("stamped", {
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", { label: "record 1" })] },
      { content: [text("filed")] },
    ]),
    tools: [reachingTool(async (ctx) => `at ${await ctx.now()}`)],
    store,
    runId: "fork-mid",
    atStep: 1,
  });
  assert.deepEqual(
    ambientEffects(live.events).map((e) => e.key),
    ["step:0#0:stamp"],
  );
});

test("an override drops the marking, because the value no longer came from the tool", async () => {
  const { store } = await recordWith(() => `at ${Date.now()}`, { calls: 2 });

  const counterfactual = await fork("stamped", {
    provider: new MockProvider([{ content: [text("filed")] }]),
    tools: [reachingTool(() => "unused")],
    store,
    runId: "set",
    atStep: 2,
    overrides: { "step:0#0:stamp": "a value you chose" },
  });

  assert.deepEqual(
    ambientEffects(counterfactual.events).map((e) => e.key),
    ["step:1#0:stamp"],
  );
});

test("verify fails the ambient check and names the call", async () => {
  const { result } = await recordWith(() => `at ${Date.now()}`);

  const report = verifyEvents("stamped", result.events);
  const check = report.checks.find((c) => c.name === "ambient");
  assert.equal(check?.status, "failed");
  assert.match(check!.detail, /step:0#0:stamp/);
  assert.match(check!.detail, /clock/);
  assert.equal(report.ok, false);
});

test("a log written before reads were watched is reported clean, not guessed at", () => {
  // An effect with no `ambient` field is exactly what an older log holds, and
  // nothing here can tell that apart from a tool that reached for nothing.
  const older = [
    { seq: 0, t: 0, type: "run.started", runId: "old", input: "x", provider: "mock", agent, budget: {} },
    { seq: 1, t: 0, type: "step.started", step: 0 },
    {
      seq: 2,
      t: 0,
      type: "effect",
      step: 0,
      index: 0,
      kind: "tool",
      key: "step:0#0:stamp",
      value: { content: "filed", isError: false },
      replayed: false,
      durationMs: 1,
    },
  ] as unknown as Parameters<typeof verifyEvents>[1];

  assert.equal(
    verifyEvents("old", older).checks.find((c) => c.name === "ambient")?.status,
    "ok",
  );
});
