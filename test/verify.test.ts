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
  type RetraceEvent,
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
  assert.match(checkNamed(report, "markings").detail, /1 stale, 1 substituted/);
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
  for (const name of ["shape", "accounting", "free replay", "markings", "parent"]) {
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
