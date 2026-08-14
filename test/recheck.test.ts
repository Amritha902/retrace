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
  MemoryStore,
  MockProvider,
  objectSchema,
  recheckRun,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  type RecheckedCall,
  type RecheckReport,
  type Tool,
  type ToolContext,
} from "../src/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/agent-module.ts", import.meta.url));
const MOVED = fileURLToPath(new URL("./fixtures/moved-module.ts", import.meta.url));
const UNSTABLE = fileURLToPath(new URL("./fixtures/unstable-module.ts", import.meta.url));

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

/** What the corpus says today. A test moves it to move the tool's answer. */
let definition = (term: string) => `definition of ${term}`;

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => definition(input.term),
});

/** Two tool calls, then an answer. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

/** What a fork at step 2 has left to do: the last turn, with no tools in it. */
const answer = () => [{ content: [text("alpha and beta, explained")] }];

function fresh(t: TestContext): MemoryStore {
  definition = (term) => `definition of ${term}`;
  t.after(() => {
    definition = (term) => `definition of ${term}`;
  });
  return new MemoryStore();
}

async function record(store: MemoryStore, tools: Tool[] = [lookup], runId = "baseline") {
  return run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools,
    store,
    runId,
  });
}

function named(report: RecheckReport, key: string): RecheckedCall {
  const found = report.calls.find((c) => c.key === key);
  assert.ok(found, `the report has no call for "${key}"`);
  return found;
}

test("recheck reads a run that died mid-flight, and re-checks the calls it made", async (t) => {
  const store = fresh(t);
  const provider = new MockProvider(script());
  const overloaded = Object.assign(new Error("the model is overloaded, try again"), {
    name: "APIOverloadedError",
  });
  await run("explain alpha and beta", {
    agent,
    provider: {
      name: "mock",
      complete: async (request) => {
        if (provider.callCount === 1) throw overloaded;
        return provider.complete(request);
      },
    },
    tools: [lookup],
    store,
    runId: "died",
  });

  // The call that threw asked for nothing, so it contributes no tool call —
  // the one the run did get through is still there to be held to the world.
  const report = await recheckRun("died", { tools: [lookup], store });

  assert.deepEqual(
    report.calls.map((c) => [c.key, c.status]),
    [["step:0#0:lookup", "same"]],
  );
  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
});

test("a log whose tools still agree with it comes back complete and still true", async (t) => {
  const store = fresh(t);
  await record(store);

  const report = await recheckRun("baseline", { tools: [lookup], store });

  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.calls.map((c) => [c.key, c.status]),
    [
      ["step:0#0:lookup", "same"],
      ["step:1#0:lookup", "same"],
    ],
  );
});

test("the question each call was put comes back out of the log with it", async (t) => {
  const store = fresh(t);
  await record(store);

  const report = await recheckRun("baseline", { tools: [lookup], store });

  // The tool's own effect holds only a digest of its input; the input itself is
  // recovered from the model response that asked for the call.
  assert.deepEqual(
    report.calls.map((c) => c.input),
    [{ term: "alpha" }, { term: "beta" }],
  );
  assert.equal(named(report, "step:0#0:lookup").recorded.content, "definition of alpha");
});

test("a tool that has changed its mind is reported moved, with both answers", async (t) => {
  const store = fresh(t);
  await record(store);

  definition = (term) => `revised definition of ${term}`;
  const report = await recheckRun("baseline", { tools: [lookup], store });

  assert.equal(report.ok, false);
  // Still complete: every call ran and was compared. It is the comparison that
  // failed, not the checking.
  assert.equal(report.complete, true);
  const moved = named(report, "step:0#0:lookup");
  assert.equal(moved.status, "moved");
  assert.equal(moved.recorded.content, "definition of alpha");
  assert.equal(moved.now?.content, "revised definition of alpha");
});

test("a tool that fails today where it answered before has moved too", async (t) => {
  const store = fresh(t);
  await record(store);

  definition = () => {
    throw new Error("the corpus is offline");
  };
  const report = await recheckRun("baseline", { tools: [lookup], store });

  const moved = named(report, "step:0#0:lookup");
  assert.equal(moved.status, "moved");
  assert.equal(moved.now?.isError, true);
  assert.equal(moved.now?.content, "the corpus is offline");
  assert.equal(moved.recorded.isError, false);
});

test("a tool that cannot agree with itself is unstable, not moved", async (t) => {
  const store = fresh(t);
  await record(store);

  // Reads a counter rather than the clock for the same reason the loop keys
  // deterministic reads by slot: two clock reads in the same millisecond are
  // equal, and this has to differ with certainty.
  let reads = 0;
  const drifting = tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => `definition of ${input.term} (read ${++reads})`,
  });

  const report = await recheckRun("baseline", { tools: [drifting], store });

  assert.equal(report.ok, false);
  // It ran and was compared, so the run is checked — it is the tool that has no
  // answer to check against.
  assert.equal(report.complete, true);
  const call = named(report, "step:0#0:lookup");
  assert.equal(call.status, "unstable");
  assert.notEqual(call.again?.content, call.now?.content);
  assert.equal(call.recorded.content, "definition of alpha");
});

test("a stable tool is asked once; only a disagreeing one is asked again", async (t) => {
  const store = fresh(t);
  await record(store);

  let executions = 0;
  const counted = tool({
    name: "lookup",
    description: "Look a term up. Call this when you need a fact you don't have.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: (input: { term: string }) => {
      executions++;
      return definition(input.term);
    },
  });

  const agreed = await recheckRun("baseline", { tools: [counted], store });
  assert.deepEqual(
    agreed.calls.map((c) => c.status),
    ["same", "same"],
  );
  // The second execution is what separates a moved corpus from an unstable
  // tool, and a call that agreed has nothing to separate. Two calls, two runs:
  // re-checking a run that holds up costs exactly what it used to.
  assert.equal(executions, 2);
  assert.equal(agreed.calls.every((c) => c.again === undefined), true);

  executions = 0;
  definition = (term) => `revised definition of ${term}`;
  const moved = await recheckRun("baseline", { tools: [counted], store });
  assert.deepEqual(
    moved.calls.map((c) => c.status),
    ["moved", "moved"],
  );
  assert.equal(executions, 4);
});

test("a tool taking its time from the journal is stable, however often it is asked", async (t) => {
  const store = fresh(t);
  const stamp = tool({
    name: "stamp",
    description: "Stamp the note with the time. Call this to file something.",
    inputSchema: objectSchema({ note: { type: "string" } }),
    run: async (input: { note: string }, ctx: ToolContext) =>
      `${input.note} filed at ${await ctx.now()}, ref ${await ctx.uuid()}`,
  });

  await run("file it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", { note: "alpha" })] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store,
    runId: "stamped",
  });

  const report = await recheckRun("stamped", { tools: [stamp], store });

  // The same tool written against `Date.now()` is the unstable case above. This
  // is what the journal buys: taking the two reads from `ctx` is the difference
  // between a tool with a recorded answer and one with none.
  assert.equal(named(report, "step:0#0:stamp").status, "same");
  assert.equal(report.ok, true);
});

test("a call naming a tool the module does not export is missing, not failed", async (t) => {
  const store = fresh(t);
  await record(store);

  const report = await recheckRun("baseline", { tools: [], store });

  // Nothing executed, so nothing disagreed — but the run is not checked either,
  // and the report says so rather than reporting a clean bill.
  assert.equal(report.ok, true);
  assert.equal(report.complete, false);
  assert.deepEqual(new Set(report.calls.map((c) => c.status)), new Set(["missing"]));
  assert.equal(named(report, "step:0#0:lookup").now, undefined);
});

test("only narrows what executes, and says the rest was skipped", async (t) => {
  const store = fresh(t);
  const executed: string[] = [];
  const writer = tool({
    name: "publish",
    description: "Publish the note. Call this once the answer is settled.",
    inputSchema: objectSchema({ body: { type: "string" } }),
    run: (input: { body: string }) => {
      executed.push(input.body);
      return "published";
    },
  });

  await run("write it up", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "alpha" })] },
      { content: [toolUse("t2", "publish", { body: "alpha" })] },
      { content: [text("done")] },
    ]),
    tools: [lookup, writer],
    store,
    runId: "baseline",
  });
  executed.length = 0;

  const report = await recheckRun("baseline", { tools: [lookup, writer], store, only: ["lookup"] });

  assert.equal(named(report, "step:0#0:lookup").status, "same");
  assert.equal(named(report, "step:1#0:publish").status, "skipped");
  assert.equal(report.complete, false);
  assert.deepEqual(executed, [], "a skipped tool must not run — that is the point of skipping it");
});

test("a substituted value is not held against the tool that never produced it", async (t) => {
  const store = fresh(t);
  await record(store);

  const counterfactual = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "nothing found" },
    store,
    runId: "counterfactual",
  });

  const report = await recheckRun(counterfactual.runId, { tools: [lookup], store });

  // The tool would say "definition of alpha" and be right to; the recorded value
  // is something a person made up. There is nothing here to hold it to.
  const made = named(report, "step:0#0:lookup");
  assert.equal(made.status, "substituted");
  assert.equal(made.recorded.content, "nothing found");
  assert.equal(made.now, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.complete, false);
  assert.equal(named(report, "step:1#0:lookup").status, "same");
});

test("a fork's free prefix is exactly what this checks: still the parent's answer", async (t) => {
  const store = fresh(t);
  await record(store);

  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  definition = (term) => `revised definition of ${term}`;
  const report = await recheckRun(forked.runId, { tools: [lookup], store });

  // Both of the fork's tool calls came out of the parent's log for free. `verify`
  // proves they are the parent's; only this can say they are no longer true.
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["moved", "moved"],
  );
});

test("a tool reading the journal is compared on what it said, not on when", async (t) => {
  const store = fresh(t);
  const stamp = tool({
    name: "stamp",
    description: "Stamp the note with an id. Call this to file something.",
    inputSchema: objectSchema({ note: { type: "string" } }),
    run: async (input: { note: string }, ctx: ToolContext) => `${input.note} filed as ${await ctx.uuid()}`,
  });

  await run("file it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", { note: "alpha" })] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store,
    runId: "stamped",
  });

  const recorded = effectsOf(store.read("stamped")).find((e) => e.kind === "uuid");
  assert.ok(recorded, "the run should have journaled the uuid the tool read");

  const report = await recheckRun("stamped", { tools: [stamp], store });

  // A fresh uuid would differ with certainty, so this passing is the recall
  // working rather than a coincidence.
  const call = named(report, "step:0#0:stamp");
  assert.equal(call.status, "same");
  assert.equal(call.now?.content, `alpha filed as ${String(recorded.value)}`);
});

test("a journal slot the log never filled reads the world instead of failing", async (t) => {
  const store = fresh(t);
  let reads = 1;
  const stamp = tool({
    name: "stamp",
    description: "Stamp the note with an id. Call this to file something.",
    inputSchema: objectSchema({ note: { type: "string" } }),
    run: async (_input: { note: string }, ctx: ToolContext) => {
      const ids: string[] = [];
      for (let i = 0; i < reads; i++) ids.push(await ctx.uuid());
      return ids.join(" ");
    },
  });

  await run("file it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", { note: "alpha" })] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store,
    runId: "stamped",
  });

  // The tool has grown a second read since. Its first slot still replays; the
  // one nobody recorded gets a fresh value rather than an error.
  reads = 2;
  const report = await recheckRun("stamped", { tools: [stamp], store });

  const call = named(report, "step:0#0:stamp");
  // Unstable rather than moved, and the distinction is the whole finding: the
  // world did not change, the tool grew a read the log does not cover. Nothing
  // it says at this slot is reproducible, so re-recording the run would not fix
  // it — which is the opposite of what "moved" would have you do.
  assert.equal(call.status, "unstable");
  assert.ok(
    call.now?.content.startsWith(`${call.recorded.content} `),
    `expected the recorded id first, got "${call.now?.content}"`,
  );
  assert.notEqual(call.again?.content, call.now?.content);
});

test("a call the log asks for but never records is not something to compare", async (t) => {
  const store = fresh(t);

  // The step asks for two lookups and the budget affords one, so the log holds a
  // model response with a call under it that has no answer.
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider([
      {
        content: [
          toolUse("t1", "lookup", { term: "alpha" }),
          toolUse("t2", "lookup", { term: "beta" }),
        ],
      },
      { content: [text("done")] },
    ]),
    tools: [lookup],
    budget: { toolCalls: 1 },
    store,
    runId: "cut-short",
  });

  const report = await recheckRun("cut-short", { tools: [lookup], store });

  assert.deepEqual(
    report.calls.map((c) => c.key),
    ["step:0#0:lookup"],
  );
});

test("a run with no tool calls has nothing to ask again", async (t) => {
  const store = fresh(t);
  await run("say something", {
    agent,
    provider: new MockProvider([{ content: [text("something")] }]),
    store,
    runId: "chat",
  });

  const report = await recheckRun("chat", { tools: [lookup], store });

  assert.deepEqual(report.calls, []);
  assert.equal(report.ok, true);
  // Vacuously: there was nothing that failed to run.
  assert.equal(report.complete, true);
});

/** A store directory that cleans itself up when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-recheck-"));
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

async function recordOnDisk(dir: string): Promise<void> {
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store: new RunStore(dir),
    runId: "baseline",
  });
}

test("the CLI re-executes the recorded calls and exits zero when they hold", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(dir);
  const io = capture();

  const code = await main(["recheck", "baseline", "--dir", dir, "--module", FIXTURE], io);

  assert.equal(code, 0);
  assert.match(io.text(), /2 recorded tool calls/);
  assert.match(io.text(), /same\s+step:0#0:lookup/);
  assert.match(io.text(), /still true: all 2 recorded tool calls return what the log holds/);
});

test("the CLI exits non-zero and prints both answers when a tool has moved", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(dir);
  const io = capture();

  const code = await main(["recheck", "baseline", "--dir", dir, "--module", MOVED], io);

  assert.equal(code, 1);
  assert.match(io.text(), /moved\s+step:0#0:lookup/);
  assert.match(io.text(), /was {2}definition of alpha/);
  assert.match(io.text(), /now {2}revised definition of alpha/);
  assert.match(io.text(), /2 of 2 re-executed tool calls no longer return what the log holds/);
});

test("the CLI names an unstable tool as such, and prints both of today's answers", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(dir);
  const io = capture();

  const code = await main(["recheck", "baseline", "--dir", dir, "--module", UNSTABLE], io);

  assert.equal(code, 1);
  assert.match(io.text(), /unstable\s+step:0#0:lookup/);
  // Two `now` lines under one `was`: both are what it says now, and that they
  // differ is the finding.
  assert.match(io.text(), /was {2}definition of alpha\n/);
  assert.match(io.text(), /now {2}definition of alpha \(read 1\)\n/);
  assert.match(io.text(), /now {2}definition of alpha \(read 2\)\n/);
  assert.match(io.text(), /2 of 2 re-executed tool calls did not give the same answer twice/);
  assert.doesNotMatch(io.text(), /the world has since changed/);
});

test("--tool keeps recheck away from the tools it should not run twice", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(dir);
  const io = capture();

  const code = await main(
    ["recheck", "baseline", "--dir", dir, "--module", MOVED, "--tool", "publish"],
    io,
  );

  assert.equal(code, 0);
  assert.match(io.text(), /skipped\s+step:0#0:lookup/);
  assert.match(io.text(), /still true as far as it goes: 0 of 2/);
  assert.match(io.text(), /2 were not asked for/);
});

test("recheck without a module says why it needs one", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(dir);
  const io = capture();

  const code = await main(["recheck", "baseline", "--dir", dir], io);

  assert.equal(code, 1);
  assert.match(io.errors(), /recheck needs --module/);
});

test("recheck without a run id says so instead of guessing", async (t) => {
  const io = capture();
  assert.equal(await main(["recheck"], io), 1);
  assert.match(io.errors(), /recheck needs a run id/);
});
