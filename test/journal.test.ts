import assert from "node:assert/strict";
import test from "node:test";
import { DivergenceError, Journal, journalUpToStep } from "../src/index.ts";

test("a fresh journal executes every effect", async () => {
  const journal = new Journal();
  let executions = 0;

  const first = await journal.effect("model", "step:0", () => {
    executions++;
    return "hello";
  });

  assert.equal(first.value, "hello");
  assert.equal(first.replayed, false);
  assert.equal(executions, 1);
  assert.equal(journal.isReplaying, false);
});

test("a preloaded journal serves values without executing", async () => {
  const journal = new Journal([
    { index: 0, kind: "model", key: "step:0", value: "recorded" },
    { index: 1, kind: "tool", key: "step:0#0:search", value: { content: "result" } },
  ]);
  let executions = 0;
  const never = () => {
    executions++;
    return "should not run";
  };

  assert.equal(journal.remaining, 2);
  const a = await journal.effect("model", "step:0", never);
  const b = await journal.effect("tool", "step:0#0:search", never);

  assert.equal(a.value, "recorded");
  assert.equal(a.replayed, true);
  assert.deepEqual(b.value, { content: "result" });
  assert.equal(executions, 0, "nothing should have been executed");
  assert.equal(journal.remaining, 0);
});

test("execution resumes live once the log runs out", async () => {
  const journal = new Journal([{ index: 0, kind: "model", key: "step:0", value: "recorded" }]);

  const replayed = await journal.effect("model", "step:0", () => "live");
  const live = await journal.effect("model", "step:1", () => "live");

  assert.equal(replayed.replayed, true);
  assert.equal(live.replayed, false);
  assert.equal(live.value, "live");
});

test("strict mode refuses to guess when the run changes shape", async () => {
  const journal = new Journal([{ index: 0, kind: "model", key: "step:0", value: "recorded" }]);

  await assert.rejects(
    () => journal.effect("tool", "step:0#0:search", () => "x"),
    (error: unknown) => {
      assert.ok(error instanceof DivergenceError);
      assert.equal(error.index, 0);
      assert.match(error.message, /diverged/);
      return true;
    },
  );
});

test('"live" divergence abandons the rest of the log and executes', async () => {
  const journal = new Journal(
    [
      { index: 0, kind: "model", key: "step:0", value: "recorded" },
      { index: 1, kind: "model", key: "step:1", value: "also recorded" },
    ],
    "live",
  );

  const diverged = await journal.effect("tool", "unexpected", () => "executed");

  assert.equal(diverged.value, "executed");
  assert.equal(diverged.replayed, false);
  assert.equal(journal.remaining, 0, "the stale tail must not be replayed");
});

test("journalUpToStep keeps only effects below the fork point, renumbered densely", () => {
  const effects = [
    { step: 0, index: 0, kind: "model", key: "step:0", value: 1 },
    { step: 0, index: 1, kind: "tool", key: "step:0#0:t", value: 2 },
    { step: 1, index: 2, kind: "model", key: "step:1", value: 3 },
    { step: 2, index: 3, kind: "model", key: "step:2", value: 4 },
  ];

  const prefix = journalUpToStep(effects, 1);
  assert.deepEqual(
    prefix.map((e) => e.key),
    ["step:0", "step:0#0:t"],
  );
  assert.deepEqual(
    prefix.map((e) => e.index),
    [0, 1],
  );
});
