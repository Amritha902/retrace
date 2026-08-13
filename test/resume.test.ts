import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  defineAgent,
  effectsOf,
  inspect,
  MemoryStore,
  MockProvider,
  objectSchema,
  resume,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  type BudgetSpec,
  type RetraceEvent,
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

/** Three model turns: two tool calls, then an answer. Five effects in all. */
function script() {
  return [
    { content: [toolUse("t1", "lookup", { term: "alpha" })] },
    { content: [toolUse("t2", "lookup", { term: "beta" })] },
    { content: [text("alpha and beta, explained")] },
  ];
}

async function recordBaseline(store: MemoryStore, budget: BudgetSpec = {}) {
  const counter = countingTool();
  const result = await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [counter.tool],
    budget,
    store,
    runId: "baseline",
  });
  return { result, counter };
}

/**
 * Copy a log up to its `keep`th effect and stop, the way a killed process
 * leaves one behind: no `run.finished`, and whatever the run was doing next
 * simply not written down.
 */
function writeTruncated(store: MemoryStore, from: string, to: string, keep: number): void {
  let effects = 0;
  for (const event of store.read(from)) {
    if (event.type === "run.finished") return;
    if (event.type === "effect") {
      if (effects === keep) return;
      effects++;
    }
    store.append(to, event);
  }
}

test("a killed run carries on from the effect its log stops at", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  assert.equal(baseline.counter.runs(), 2);
  // Effects 0-2 are step 0 whole and step 1's model call; the tool call step 1
  // asked for never made it to disk.
  writeTruncated(store, "baseline", "killed", 3);
  assert.equal(inspect("killed", store).status, "running");

  const counter = countingTool();
  const provider = new MockProvider([{ content: [text("alpha and beta, explained")] }]);
  const resumed = await resume("killed", {
    provider,
    tools: [counter.tool],
    store,
    runId: "resumed",
  });

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, baseline.result.output);
  assert.equal(provider.callCount, 1, "only the step past the end of the log reaches the model");
  assert.equal(counter.runs(), 1, "only the tool call the log never recorded runs");

  const effects = effectsOf(resumed.events);
  assert.deepEqual(
    effects.map((e) => e.replayed),
    [true, true, true, false, false],
    "the log replays whole, and the run goes live where it ends",
  );
  assert.equal(effects[3]?.key, "step:1#0:lookup");
});

test("the replayed part of a resume is the parent's log, effect for effect", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  writeTruncated(store, "baseline", "killed", 3);

  const resumed = await resume("killed", {
    provider: new MockProvider([{ content: [text("alpha and beta, explained")] }]),
    tools: [countingTool().tool],
    store,
    runId: "resumed",
  });

  const identity = (e: { kind: string; key: string; value: unknown }) => ({
    kind: e.kind,
    key: e.key,
    value: e.value,
  });
  assert.deepEqual(
    effectsOf(resumed.events).slice(0, 3).map(identity),
    effectsOf(baseline.result.events).slice(0, 3).map(identity),
  );
});

test("a resume records what it picked up from, and what state that was in", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  writeTruncated(store, "baseline", "killed", 3);

  await resume("killed", {
    provider: new MockProvider([{ content: [text("done")] }]),
    tools: [countingTool().tool],
    store,
    runId: "resumed",
  });

  assert.deepEqual(inspect("resumed", store).forkedFrom, {
    runId: "killed",
    atStep: "all",
    resumed: { after: 3, parentStatus: "running" },
  });
});

test("a log that holds the whole run finishes on replay, spending nothing", async () => {
  // The run got its answer and died before writing that it had. Nothing is left
  // to execute, and a resume says so rather than inventing work.
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);
  writeTruncated(store, "baseline", "killed", 5);

  const counter = countingTool();
  const provider = new MockProvider([]);
  const resumed = await resume("killed", {
    provider,
    tools: [counter.tool],
    store,
    runId: "resumed",
  });

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, baseline.result.output);
  assert.equal(provider.callCount, 0);
  assert.equal(counter.runs(), 0);
  assert.equal(resumed.totals.billedUsd, 0);
  assert.ok(effectsOf(resumed.events).every((e) => e.replayed));
});

test("resuming a run that ended with an answer is refused", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await assert.rejects(
    resume("baseline", { provider: new MockProvider([]), store, runId: "pointless" }),
    /ended completed.*nothing left of it to run.*replay.*fork/s,
  );
  assert.equal(store.list().includes("pointless"), false, "a refused resume writes no log");
});

test("resuming a run the model declined is refused too", async () => {
  const store = new MemoryStore();
  await run("do something off limits", {
    agent,
    provider: new MockProvider([{ content: [text("no")], stopReason: "refusal" as const }]),
    tools: [],
    store,
    runId: "declined",
  });
  assert.equal(inspect("declined", store).status, "refused");

  await assert.rejects(
    resume("declined", { provider: new MockProvider([]), store }),
    /ended refused/,
  );
});

test("a run that stopped at a limit resumes only when the limit moves", async () => {
  const store = new MemoryStore();
  const stopped = await recordBaseline(store, { steps: 2 });
  assert.equal(stopped.result.status, "budget_exceeded");

  // The same budget again: the replayed steps spend it exactly as the parent
  // did, so the run stops in the same place having executed nothing.
  const stuck = await resume("baseline", {
    provider: new MockProvider([]),
    tools: [countingTool().tool],
    store,
    runId: "stuck",
  });
  assert.equal(stuck.status, "budget_exceeded");
  assert.ok(effectsOf(stuck.events).every((e) => e.replayed));

  const counter = countingTool();
  const provider = new MockProvider([{ content: [text("alpha and beta, explained")] }]);
  const carried = await resume("baseline", {
    provider,
    tools: [counter.tool],
    budget: { steps: 5 },
    store,
    runId: "carried",
  });

  assert.equal(carried.status, "completed");
  assert.equal(provider.callCount, 1);
  assert.equal(counter.runs(), 0, "both recorded tool calls come out of the log");
  assert.equal(carried.totals.savedUsd, stopped.result.totals.costUsd);
});

/** A real store directory that cleans itself up when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-resume-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const logPath = (dir: string, runId: string) => join(dir, "runs", `${runId}.jsonl`);

test("a log torn mid-line by a kill is read as the prefix it is", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  const counter = countingTool();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [counter.tool],
    store,
    runId: "baseline",
  });

  // Six whole events, then half of the seventh and no newline — what
  // appendFileSync leaves behind when the process dies inside a write.
  const path = logPath(dir, "baseline");
  const lines = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, `${lines.slice(0, 6).join("\n")}\n${lines[6]!.slice(0, 20)}`, "utf8");

  const events = store.read("baseline");
  assert.equal(events.length, 6, "the half-written line is dropped, the whole ones are kept");
  assert.equal(events.at(-1)?.type, "effect");

  const live = countingTool();
  const resumed = await resume("baseline", {
    provider: new MockProvider(script().slice(1)),
    tools: [live.tool],
    store,
    runId: "resumed",
  });

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "alpha and beta, explained");
  assert.equal(live.runs(), 1, "the tool call the torn log did record is not run again");
});

test("a broken line anywhere but the end is still corruption", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  const events: RetraceEvent[] = [
    { seq: 0, t: 1, type: "step.started", step: 0 },
    { seq: 1, t: 2, type: "step.started", step: 1 },
  ];
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(
    logPath(dir, "mangled"),
    `${JSON.stringify(events[0])}\n{not json\n${JSON.stringify(events[1])}\n`,
    "utf8",
  );

  assert.throws(() => store.read("mangled"), /run "mangled" has a corrupt event on line 2/);
});
