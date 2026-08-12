import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  MemoryStore,
  MockProvider,
  objectSchema,
  priceUsage,
  run,
  setRate,
  text,
  tool,
  toolUse,
} from "../src/index.ts";

const noop = tool({
  name: "noop",
  description: "Does nothing. Call this when a step needs a tool call.",
  inputSchema: objectSchema({}),
  run: () => "ok",
});

test("usage is priced from the model's rate card", () => {
  // Claude Opus 5: $5 per million in, $25 per million out.
  const cost = priceUsage("claude-opus-5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(cost, 30);
});

test("cache reads bill at a tenth of input, writes at 1.25x", () => {
  const cost = priceUsage("claude-opus-5", {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });
  assert.equal(Math.round(cost * 100) / 100, 0.5 + 6.25);
});

test("an unknown model prices at zero rather than guessing", () => {
  const cost = priceUsage("some-model-that-does-not-exist", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(cost, 0);
  setRate("some-model-that-does-not-exist", { input: 1, output: 2 });
  assert.equal(
    priceUsage("some-model-that-does-not-exist", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    3,
  );
});

test("a spend ceiling stops the run instead of crashing it", async () => {
  const provider = new MockProvider(
    Array.from({ length: 10 }, () => ({
      content: [toolUse("t", "noop", {})],
      usage: { inputTokens: 200_000, outputTokens: 20_000 },
    })),
  );

  const result = await run("spend", {
    agent: defineAgent({ name: "spender", model: "claude-opus-5", maxSteps: 10 }),
    provider,
    tools: [noop],
    budget: { usd: 2 },
    store: new MemoryStore(),
  });

  assert.equal(result.status, "budget_exceeded");
  assert.match(result.error ?? "", /usd limit is 2/);
  // $1.50 per step, so it stops as soon as the running total crosses $2.
  assert.equal(result.totals.steps, 2);
  assert.ok(result.totals.billedUsd >= 2);
});

test("a tool-call ceiling is enforced mid-step", async () => {
  const provider = new MockProvider([
    { content: [toolUse("a", "noop", {}), toolUse("b", "noop", {}), toolUse("c", "noop", {})] },
    { content: [text("done")] },
  ]);

  const result = await run("go", {
    agent: defineAgent({ name: "toolhappy", maxSteps: 5 }),
    provider,
    tools: [noop],
    budget: { toolCalls: 2 },
    store: new MemoryStore(),
  });

  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.totals.toolCalls, 2);
});

test("a step ceiling stops before the next model call", async () => {
  const provider = new MockProvider(
    Array.from({ length: 5 }, () => ({ content: [toolUse("t", "noop", {})] })),
  );

  const result = await run("go", {
    agent: defineAgent({ name: "stepper", maxSteps: 5 }),
    provider,
    tools: [noop],
    budget: { steps: 3 },
    store: new MemoryStore(),
  });

  assert.equal(result.status, "budget_exceeded");
  assert.equal(provider.callCount, 3, "the fourth model call must never be made");
});
