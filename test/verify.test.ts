import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  resume,
  run,
  RunStore,
  StreamingMockProvider,
  text,
  tool,
  toolUse,
  verifyEvents,
  verifyRun,
  type Check,
  type RecordedRead,
  type RetraceEvent,
  type ToolContext,
  type VerifyReport,
} from "../src/index.ts";

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/** Three model turns: two tool calls, then an answer. Five effects in all. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

const answer = () => [{ content: [text("alpha and beta, explained")] }];

async function recordBaseline(store: MemoryStore, runId = "baseline") {
  return run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId,
  });
}

function checkNamed(report: VerifyReport, name: string): Check {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `the report has no check called "${name}"`);
  return found;
}

function assertPasses(report: VerifyReport, except: readonly string[] = []): void {
  for (const check of report.checks) {
    const expected = except.includes(check.name) ? "skipped" : "ok";
    assert.equal(check.status, expected, `${check.name}: ${check.detail}`);
  }
  assert.equal(report.ok, true);
}

/** The log with one event handed to `edit`, the way a hand-edited file would be. */
function tampered(
  events: readonly RetraceEvent[],
  find: (e: RetraceEvent) => boolean,
  edit: (e: RetraceEvent) => void,
): RetraceEvent[] {
  const copy = structuredClone(events) as RetraceEvent[];
  const target = copy.find(find);
  assert.ok(target, "the tamper test found nothing to edit");
  edit(target);
  return copy;
}

test("a recorded run is consistent with itself, and says what it could not check", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const report = verifyRun("baseline", store);

  assertPasses(report, ["parent"]);
  assert.equal(report.complete, false, "a run with no parent has not been checked against one");
  assert.match(checkNamed(report, "shape").detail, /5 effects/);
  assert.match(checkNamed(report, "accounting").detail, /the charges add up/);
  assert.match(checkNamed(report, "free replay").detail, /nothing was replayed/);
  assert.match(checkNamed(report, "parent").detail, /not a fork/);
});

test("a fork's free prefix is checked against the run it came from, effect for effect", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  const report = verifyRun("forked", store);

  assertPasses(report);
  assert.equal(report.complete, true, "everything about a fork with its parent to hand is checkable");
  assert.match(checkNamed(report, "free replay").detail, /4 of 5 effects came out of the log/);
  assert.match(checkNamed(report, "parent").detail, /4 replayed effects are baseline's, value for value/);
});

test("a resumed run, and the killed log it picked up from, both hold up", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  // A killed run: the log stops after step 1's model call, so step 1's tool call
  // and everything above it was never written down.
  let effects = 0;
  for (const event of store.read("baseline")) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && effects++ === 3) break;
    store.append("killed", event);
  }

  await resume("killed", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    store,
    runId: "resumed",
  });

  // A log with no run.finished has no totals to be held to, and that is the one
  // thing about it that cannot be checked rather than a fault in it.
  const killed = verifyRun("killed", store);
  assert.equal(killed.ok, true);
  assert.equal(checkNamed(killed, "accounting").status, "skipped");
  assert.match(checkNamed(killed, "accounting").detail, /no run\.finished/);

  assertPasses(verifyRun("resumed", store));
  assert.match(checkNamed(verifyRun("resumed", store), "parent").detail, /3 replayed effects are killed's/);
});

test("a substituted value is counted rather than held against the parent", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  const report = verifyRun("counterfactual", store);

  assertPasses(report);
  // The substituted effect is the one place a fork's log is *meant* to disagree
  // with its parent, so it is excluded from the comparison and said out loud.
  assert.match(checkNamed(report, "parent").detail, /3 replayed effects are baseline's/);
  assert.match(checkNamed(report, "parent").detail, /1 substituted on purpose/);
  // The substitution changed what step 1 was told, and nothing else about the
  // request — so the staleness it caused names the conversation and not the
  // prompt, which is how you tell the two apart from the log alone.
  assert.match(
    checkNamed(report, "markings").detail,
    /1 stale \(conversation\), 1 substituted/,
  );
});

test("a tool call answered from the wrong slot is a marking the audit accepts and names", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    // Substituting a model response is the one thing that moves a tool's input
    // without moving its slot. The resulting log says so about itself, and the
    // audit's job here is to accept that as a legitimate marking rather than
    // treat a stale tool call as a shape it has never seen.
    overrides: {
      "step:0": {
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: { term: "omega" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
    store,
    runId: "rerouted",
  });

  const report = verifyRun("rerouted", store);

  assertPasses(report);
  assert.match(
    checkNamed(report, "markings").detail,
    /2 stale \(conversation, input\), 1 substituted/,
  );
});

test("parallel tool calls and a streamed turn leave a log that verifies like any other", async () => {
  const store = new MemoryStore();
  const parallel = defineAgent({ ...agent, parallelTools: true });
  const both = [
    {
      content: [
        toolUse("t1", "lookup", { term: "alpha" }),
        toolUse("t2", "lookup", { term: "beta" }),
      ],
    },
    { content: [text("alpha and beta, explained")] },
  ];

  await run("explain alpha and beta", {
    agent: parallel,
    provider: new StreamingMockProvider(both),
    tools: [lookup],
    store,
    runId: "at-once",
    onStream: () => {},
  });

  assertPasses(verifyRun("at-once", store), ["parent"]);
  assert.match(checkNamed(verifyRun("at-once", store), "shape").detail, /4 effects/);
});

test("a value edited inside a replayed prefix fails against the parent", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  const edited = tampered(
    forked.events,
    (e) => e.type === "effect" && e.key === "step:1#0:lookup",
    (e) => {
      if (e.type === "effect") e.value = { content: "definition of something else", isError: false };
    },
  );

  const report = verifyEvents("forked", edited, store);

  assert.equal(report.ok, false);
  assert.equal(checkNamed(report, "parent").status, "failed");
  assert.match(
    checkNamed(report, "parent").detail,
    /tool:step:1#0:lookup was served a different value than baseline recorded/,
  );
});

test("a line lifted out of the middle of a log fails the shape check", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const events = store.read("baseline");
  const short = events.filter((e) => e.type !== "message" || e.step !== 0);

  const report = verifyEvents("baseline", short, store);

  assert.equal(report.ok, false);
  assert.match(checkNamed(report, "shape").detail, /a line is missing/);
});

test("a run cannot claim to have saved more than its charges account for", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const inflated = tampered(
    store.read("baseline"),
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.totals = { ...e.totals, savedUsd: 12.5 };
    },
  );

  const report = verifyEvents("baseline", inflated, store);

  assert.equal(report.ok, false);
  assert.match(checkNamed(report, "accounting").detail, /claims to have saved \$12\.5000/);
});

test("an effect served from the log cannot also have been billed", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  const billed = tampered(
    forked.events,
    (e) => e.type === "charge" && e.step === 0,
    (e) => {
      if (e.type === "charge") e.billedUsd = e.costUsd;
    },
  );

  const report = verifyEvents("forked", billed, store);

  assert.equal(report.ok, false);
  assert.match(checkNamed(report, "free replay").detail, /step:0 came out of the log but was billed/);
});

test("a value marked substituted that the run was never asked to substitute fails", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  const marked = tampered(
    forked.events,
    (e) => e.type === "effect" && e.key === "step:1#0:lookup",
    (e) => {
      if (e.type === "effect") e.overridden = true;
    },
  );

  const report = verifyEvents("forked", marked, store);

  assert.equal(report.ok, false);
  assert.match(
    checkNamed(report, "markings").detail,
    /step:1#0:lookup was substituted, but the run does not record having been asked/,
  );
});

test("an effect naming what moved without being stale fails", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  // Nothing changed on this fork, so nothing should be stale. A log that names
  // a component as having moved while claiming the request still matches is
  // contradicting itself, whichever half of it you believe.
  const marked = tampered(
    forked.events,
    (e) => e.type === "effect" && e.key === "step:0",
    (e) => {
      if (e.type === "effect") e.staleFacets = ["system"];
    },
  );

  const report = verifyEvents("forked", marked, store);

  assert.equal(report.ok, false);
  assert.match(
    checkNamed(report, "markings").detail,
    /step:0 names system as having changed but is not marked stale/,
  );
});

test("a fork whose parent is gone is unverified in one respect rather than failed", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  // The fork's own log, read somewhere its parent never reached.
  const report = verifyEvents("forked", forked.events, new MemoryStore());

  assert.equal(report.ok, true, "a missing parent is not evidence of anything wrong with this log");
  assert.equal(report.complete, false);
  assert.equal(checkNamed(report, "parent").status, "skipped");
  assert.match(checkNamed(report, "parent").detail, /"baseline"\) is not in this store/);
});

/** A store holding exactly these logs, so a lineage can be given holes on purpose. */
function storeOf(runs: Record<string, readonly RetraceEvent[]>): MemoryStore {
  const store = new MemoryStore();
  for (const [runId, events] of Object.entries(runs)) {
    for (const event of events) store.append(runId, event);
  }
  return store;
}

/** baseline, then `depth` forks each taken from the one before it at step 2. */
async function chain(store: MemoryStore, depth: number): Promise<string[]> {
  await recordBaseline(store);
  const ids = ["baseline"];
  for (let i = 1; i <= depth; i++) {
    const runId = `fork-${i}`;
    await fork(ids[i - 1] as string, {
      provider: new MockProvider(answer()),
      tools: [lookup],
      atStep: 2,
      store,
      runId,
    });
    ids.push(runId);
  }
  return ids;
}

test("a fork of a fork traces what it got free back to the run that executed it", async () => {
  const store = new MemoryStore();
  await chain(store, 3);

  const report = verifyRun("fork-3", store);

  assertPasses(report);
  // Its parent is fork-2, which paid for none of this either. Only the run at
  // the end of the chain ever reached a model or a tool.
  assert.match(checkNamed(report, "parent").detail, /4 replayed effects are fork-2's/);
  assert.match(
    checkNamed(report, "lineage").detail,
    /4 free effects trace back 3 runs to baseline, which executed and paid for them/,
  );
});

test("a log claiming a free prefix it came by from nowhere fails", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  // Drop the one line saying where the free prefix came from. Everything else
  // about the log is untouched, including the $0 it billed for four effects.
  const orphaned = tampered(
    forked.events,
    (e) => e.type === "run.started",
    (e) => {
      if (e.type === "run.started") delete e.forkedFrom;
    },
  );

  const report = verifyEvents("forked", orphaned, store);

  assert.equal(report.ok, false);
  assert.equal(checkNamed(report, "parent").status, "skipped", "with no origin there is no parent to check");
  assert.match(
    checkNamed(report, "lineage").detail,
    /4 effects came out of a log, but this run records no run to have come from/,
  );
});

test("a value doctored in the middle of a lineage passes its child and fails the chain", async () => {
  const store = new MemoryStore();
  await chain(store, 2);

  // Rewrite the same effect in fork-1 and fork-2, so the two agree with each
  // other and only the run that actually executed it disagrees. This is the
  // failure the one-hop check cannot see: fork-2's prefix really is fork-1's.
  const forge = (events: readonly RetraceEvent[]) =>
    tampered(
      events,
      (e) => e.type === "effect" && e.key === "step:1#0:lookup",
      (e) => {
        if (e.type === "effect") e.value = { content: "definition of something else", isError: false };
      },
    );

  const doctored = storeOf({
    baseline: store.read("baseline"),
    "fork-1": forge(store.read("fork-1")),
    "fork-2": forge(store.read("fork-2")),
  });

  const report = verifyEvents("fork-2", doctored.read("fork-2"), doctored);

  assert.equal(checkNamed(report, "parent").status, "ok", "the doctored pair agree with each other");
  assert.equal(report.ok, false);
  assert.match(
    checkNamed(report, "lineage").detail,
    /baseline records a different value for tool:step:1#0:lookup than fork-1, which took it from there/,
  );
});

test("a lineage that runs out of this store is traced as far as it goes", async () => {
  const store = new MemoryStore();
  await chain(store, 2);

  // fork-2 and its parent, read somewhere the run that paid for any of it never
  // reached — an ordinary way to receive a fork, and not evidence of anything.
  const partial = storeOf({ "fork-1": store.read("fork-1"), "fork-2": store.read("fork-2") });
  const report = verifyEvents("fork-2", partial.read("fork-2"), partial);

  assert.equal(report.ok, true);
  assert.equal(report.complete, false);
  assert.equal(checkNamed(report, "parent").status, "ok", "the hop this store can see holds");
  assert.equal(checkNamed(report, "lineage").status, "skipped");
  assert.match(
    checkNamed(report, "lineage").detail,
    /nothing this run got free can be traced to the run that ran it: the trail stops where "baseline" is not in this store/,
  );
});

test("a run that is its own ancestor is refused rather than followed", async () => {
  const store = new MemoryStore();
  await chain(store, 1);

  const looped = storeOf({
    // baseline now claims to have been forked from the run that was forked from it.
    baseline: tampered(
      store.read("baseline"),
      (e) => e.type === "run.started",
      (e) => {
        if (e.type === "run.started") e.forkedFrom = { runId: "fork-1", atStep: 0 };
      },
    ),
    "fork-1": store.read("fork-1"),
  });

  const report = verifyEvents("fork-1", looped.read("fork-1"), looped);

  assert.equal(report.ok, false);
  assert.match(
    checkNamed(report, "lineage").detail,
    /"baseline" is its own ancestor, which no sequence of forks produces/,
  );
});

test("a substituted value an ancestor invented is traced to nothing, and said so", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });
  await fork("counterfactual", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "downstream",
  });

  const report = verifyRun("downstream", store);

  assertPasses(report);
  // Three of its four free effects were executed by baseline. The fourth never
  // existed anywhere: the run above it made the value up, which is the point.
  assert.match(
    checkNamed(report, "lineage").detail,
    /3 free effects trace back 2 runs to baseline, which executed and paid for them; 1 more carries a value substituted somewhere in this lineage rather than executed anywhere in it/,
  );
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-verify-"));
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

test("the CLI reports every check and exits zero when they hold", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
  await fork("baseline", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });
  const io = capture();

  const code = await main(["verify", "forked", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /forked from baseline at step 2/);
  for (const name of ["shape", "accounting", "free replay", "markings", "parent", "lineage"]) {
    assert.match(io.text(), new RegExp(`ok\\s+${name}\\s`));
  }
  assert.match(io.text(), /verified: this log holds up against everything it claims/);
});

test("the CLI says where a resumed run picked up, and holds it to that log", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
  let effects = 0;
  for (const event of store.read("baseline")) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && effects++ === 3) break;
    store.append("killed", event);
  }
  await resume("killed", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    store,
    runId: "resumed",
  });
  const io = capture();

  const code = await main(["verify", "resumed", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /picked up from killed, which stopped running after 3 effects/);
  assert.match(io.text(), /3 replayed effects are killed's, value for value/);
});

test("the CLI exits non-zero and names the check a doctored log fails", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });

  const path = join(dir, "runs", "baseline.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const doctored = lines.map((line) => {
    const event = JSON.parse(line) as RetraceEvent;
    if (event.type === "run.finished") event.totals = { ...event.totals, billedUsd: 0 };
    return JSON.stringify(event);
  });
  writeFileSync(path, `${doctored.join("\n")}\n`, "utf8");
  const io = capture();

  const code = await main(["verify", "baseline", "--dir", dir], io);

  assert.equal(code, 1);
  assert.match(io.text(), /fail\s+accounting/);
  assert.match(io.text(), /unverified: accounting/);
});

test("verify without a run id says so instead of guessing", async (t) => {
  const io = capture();
  const code = await main(["verify", "--dir", tempDir(t)], io);
  assert.equal(code, 1);
  assert.match(io.errors(), /verify needs a run id/);
});

/**
 * A tool that takes its answer and its time from `ctx`, so a run has journaled
 * reads to hold: one of each sort, since a `read` carries a digest of what it
 * asked and a clock read is an answer to no question and carries only its slot.
 */
const consult = tool({
  name: "consult",
  description: "Consult the corpus. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: async (input: { term: string }, ctx: ToolContext) =>
    `${await ctx.read("corpus", input, () => `definition of ${input.term}`)}, at ${await ctx.now()}`,
});

async function recordReads(store: MemoryStore, runId = "reads") {
  return run("explain alpha", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "consult", { term: "alpha" })] },
      { content: [text("alpha, explained")] },
    ]),
    tools: [consult],
    store,
    runId,
  });
}

/** The reads inside a log's tool calls, which is what the `reads` check walks. */
function nested(events: readonly RetraceEvent[]): Extract<RetraceEvent, { type: "effect" }>[] {
  return events.filter(
    (e): e is Extract<RetraceEvent, { type: "effect" }> =>
      e.type === "effect" && e.key.includes("/"),
  );
}

test("a log's journaled reads are held to the slots their own values name", async () => {
  const store = new MemoryStore();
  await recordReads(store);

  const report = verifyRun("reads", store);

  assertPasses(report, ["parent"]);
  assert.equal(
    checkNamed(report, "reads").detail,
    "2 journaled reads sit in the calls that made them; 1 holds the question its own slot is a digest of",
  );
});

test("a log whose tools read nothing has nothing to hold, and passes rather than skipping", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const check = checkNamed(verifyRun("baseline", store), "reads");

  assert.equal(check.status, "ok", "a log with no reads has none that could disagree with a slot");
  assert.match(check.detail, /no tool in this log read a clock/);
});

test("a read whose recorded question was edited answers a slot it is not in", async () => {
  const store = new MemoryStore();
  const result = await recordReads(store);
  const edited = tampered(
    result.events,
    (e) => e.type === "effect" && e.kind === "read",
    (e) => {
      if (e.type === "effect") (e.value as RecordedRead).question = { term: "beta" };
    },
  );

  const report = verifyEvents("reads", edited, store);

  const check = checkNamed(report, "reads");
  assert.equal(check.status, "failed");
  assert.match(check.detail, /"corpus" answering \{"term":"beta"\}/);
  // The point of the check: a read is reached from neither the conversation nor
  // a response, so every other check in the report passes this edit.
  assert.equal(checkNamed(report, "requests").status, "ok");
  assert.equal(checkNamed(report, "shape").status, "ok");
});

test("a read moved under a call that never made it names the call it claims", async () => {
  const store = new MemoryStore();
  const result = await recordReads(store);
  const edited = tampered(
    result.events,
    (e) => e.type === "effect" && e.kind === "read",
    (e) => {
      if (e.type === "effect") e.key = e.key.replace("step:0#0:", "step:0#1:");
    },
  );

  const check = checkNamed(verifyEvents("reads", edited, store), "reads");

  assert.equal(check.status, "failed");
  assert.match(check.detail, /is a read inside "step:0#1:consult", and this log records no tool call by that name/);
});

test("a read claiming a slot its call never handed out says where the sequence was", async () => {
  const store = new MemoryStore();
  const result = await recordReads(store);
  const edited = tampered(
    result.events,
    (e) => e.type === "effect" && e.kind === "clock",
    (e) => {
      if (e.type === "effect") e.key = e.key.replace("clock:0", "clock:1");
    },
  );

  const check = checkNamed(verifyEvents("reads", edited, store), "reads");

  assert.equal(check.status, "failed");
  assert.match(check.detail, /claims clock slot 1 of "step:0#0:consult", where that call's clock reads are at 0/);
});

test("the reads of a fork's replayed prefix are held exactly as its parent's are", async () => {
  const store = new MemoryStore();
  await recordReads(store);

  const forked = await fork("reads", {
    provider: new MockProvider([{ content: [text("alpha, tersely")] }]),
    tools: [consult],
    atStep: 1,
    agent: { system: "Be terse." },
    store,
    runId: "reads-forked",
  });

  assert.deepEqual(
    nested(forked.events).map((e) => e.key),
    nested(store.read("reads")).map((e) => e.key),
  );
  assertPasses(verifyEvents("reads-forked", forked.events, store));
});
