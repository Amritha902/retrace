import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  collectBundle,
  defineAgent,
  fork,
  importBundle,
  MemoryStore,
  MockProvider,
  objectSchema,
  parseBundle,
  run,
  RunStore,
  serializeBundle,
  text,
  tool,
  toolUse,
  verifyRun,
  type Bundle,
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

/** Two tool calls, then an answer: three steps, five effects. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

const answer = () => [{ content: [text("alpha and beta, explained")] }];

/** baseline, then `depth` forks each taken from the one before it at step 2. */
async function chain(store: RunStore, depth: number): Promise<string[]> {
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
  const ids = ["baseline"];
  for (let i = 1; i <= depth; i++) {
    await fork(ids[i - 1] as string, {
      provider: new MockProvider(answer()),
      tools: [lookup],
      atStep: 2,
      store,
      runId: `fork-${i}`,
    });
    ids.push(`fork-${i}`);
  }
  return ids;
}

function storeOf(runs: Record<string, readonly RetraceEvent[]>): MemoryStore {
  const store = new MemoryStore();
  for (const [runId, events] of Object.entries(runs)) {
    for (const event of events) store.append(runId, event);
  }
  return store;
}

function checkNamed(report: VerifyReport, name: string): Check {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `the report has no check called "${name}"`);
  return found;
}

/** A store directory that cleans itself up when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One log, copied on its own — how a fork arrives somewhere its parent isn't. */
function handOver(from: string, to: string, runId: string): void {
  mkdirSync(join(to, "runs"), { recursive: true });
  writeFileSync(join(to, "runs", `${runId}.jsonl`), readFileSync(join(from, "runs", `${runId}.jsonl`)));
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

const roundTrip = (bundle: Bundle): Bundle => parseBundle(serializeBundle(bundle));

test("a bundle carries the run and every run it was forked from", async () => {
  const store = new MemoryStore();
  await chain(store, 3);

  const bundle = collectBundle("fork-3", store);

  assert.equal(bundle.root, "fork-3");
  assert.deepEqual(
    bundle.runs.map((r) => r.runId),
    ["fork-3", "fork-2", "fork-1", "baseline"],
    "the root first, then each ancestor, nearest first",
  );
  assert.equal(bundle.complete, true);
  for (const carried of bundle.runs) {
    assert.deepEqual(carried.events, store.read(carried.runId), `${carried.runId} came through whole`);
  }
});

test("a run forked from nothing is the whole of its own lineage", async () => {
  const store = new MemoryStore();
  await chain(store, 0);

  const bundle = collectBundle("baseline", store);

  assert.deepEqual(
    bundle.runs.map((r) => r.runId),
    ["baseline"],
  );
  assert.equal(bundle.complete, true);
});

test("importing a bundle turns verify's skipped lineage into a passing one", async () => {
  const source = new MemoryStore();
  await chain(source, 2);

  // How a fork ordinarily arrives somewhere else: the log, and nothing the log
  // is owed to. verify can check the one hop it can see and no more.
  const alone = storeOf({ "fork-2": source.read("fork-2") });
  const before = verifyRun("fork-2", alone);
  assert.equal(before.complete, false);
  assert.equal(checkNamed(before, "lineage").status, "skipped");

  const elsewhere = new MemoryStore();
  const report = importBundle(roundTrip(collectBundle("fork-2", source)), elsewhere);

  assert.deepEqual(report.added, ["baseline", "fork-1", "fork-2"], "oldest ancestor written first");
  assert.deepEqual(report.present, []);
  assert.equal(report.complete, true);

  const after = verifyRun("fork-2", elsewhere);
  assert.equal(after.ok, true);
  assert.equal(after.complete, true, "every check had something to run against");
  assert.equal(checkNamed(after, "lineage").status, "ok");
  assert.match(
    checkNamed(after, "lineage").detail,
    /trace back 2 runs to baseline, which executed and paid for them/,
  );
});

test("a bundle round-trips through its file, byte for byte", async () => {
  const store = new MemoryStore();
  await chain(store, 1);

  const bundle = collectBundle("fork-1", store);
  const text = serializeBundle(bundle);
  const read = parseBundle(text);

  assert.deepEqual(read, bundle);
  assert.equal(serializeBundle(read), text, "re-writing what was read gives the same file");
  assert.equal(
    text.split("\n").filter((l) => l !== "").length,
    1 + store.read("fork-1").length + store.read("baseline").length,
    "a header, then every event of every run it carries, one to a line",
  );
});

test("a chain that leaves the store is bundled as far as it goes, and says so", async () => {
  const source = new MemoryStore();
  await chain(source, 2);
  const partial = storeOf({ "fork-1": source.read("fork-1"), "fork-2": source.read("fork-2") });

  const bundle = collectBundle("fork-2", partial);

  assert.deepEqual(
    bundle.runs.map((r) => r.runId),
    ["fork-2", "fork-1"],
  );
  assert.equal(bundle.complete, false);
  assert.match(bundle.incomplete ?? "", /"baseline" is not in this store/);

  // Still worth having: it carries the hop `parent` needs, and reports the rest
  // skipped for the same reason the store it came from did.
  const elsewhere = new MemoryStore();
  const report = importBundle(roundTrip(bundle), elsewhere);
  assert.equal(report.complete, false);

  const verified = verifyRun("fork-2", elsewhere);
  assert.equal(verified.ok, true);
  assert.equal(checkNamed(verified, "parent").status, "ok");
  assert.equal(checkNamed(verified, "lineage").status, "skipped");
});

test("a run that claims to be its own ancestor is refused rather than followed", async () => {
  const store = new MemoryStore();
  await chain(store, 1);

  const events = structuredClone(store.read("baseline")) as RetraceEvent[];
  const started = events.find((e) => e.type === "run.started");
  assert.ok(started?.type === "run.started");
  started.forkedFrom = { runId: "fork-1", atStep: 2 };
  const looped = storeOf({ baseline: events, "fork-1": store.read("fork-1") });

  assert.throws(
    () => collectBundle("fork-1", looped),
    /"fork-1" is its own ancestor, which no sequence of forks produces/,
  );
});

test("exporting a run this store does not have is an error, not an empty bundle", () => {
  assert.throws(() => collectBundle("nothing", new MemoryStore()), /no run "nothing"/);
});

test("importing the same bundle twice adds nothing the second time", async () => {
  const source = new MemoryStore();
  await chain(source, 1);
  const bundle = roundTrip(collectBundle("fork-1", source));

  const store = new MemoryStore();
  const first = importBundle(bundle, store);
  const second = importBundle(bundle, store);

  assert.deepEqual(first.added, ["baseline", "fork-1"]);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.present, ["baseline", "fork-1"]);
  assert.deepEqual(store.read("fork-1"), source.read("fork-1"), "nothing was appended twice");
});

test("a bundle carrying a different run under a name the store holds is refused", async () => {
  const source = new MemoryStore();
  await chain(source, 1);

  const doctored = structuredClone(source.read("baseline")) as RetraceEvent[];
  const target = doctored.find((e) => e.type === "effect" && e.key === "step:0#0:lookup");
  assert.ok(target?.type === "effect");
  target.value = { content: "definition of something else entirely", isError: false };

  const store = storeOf({ baseline: source.read("baseline") });
  const bundle = roundTrip(collectBundle("fork-1", storeOf({ baseline: doctored, "fork-1": source.read("fork-1") })));

  assert.throws(
    () => importBundle(bundle, store),
    /"baseline" is already in .* and is not the run this bundle carries/,
  );
});

test("importing leaves runs the store already holds alone", async () => {
  const source = new MemoryStore();
  await chain(source, 1);

  const store = storeOf({ baseline: source.read("baseline") });
  const report = importBundle(roundTrip(collectBundle("fork-1", source)), store);

  assert.deepEqual(report.added, ["fork-1"]);
  assert.deepEqual(report.present, ["baseline"]);
  assert.equal(verifyRun("fork-1", store).complete, true);
});

test("a file that is not a bundle is named as such rather than half-read", () => {
  assert.throws(() => parseBundle(""), /bundle is empty/);
  assert.throws(() => parseBundle("not json\n"), /bundle line 1 is not JSON/);
  assert.throws(() => parseBundle("[1,2]\n"), /bundle line 1 is not a JSON object/);
  assert.throws(() => parseBundle('{"seq":0,"type":"run.started"}\n'), /not a retrace bundle/);
  assert.throws(
    () => parseBundle('{"format":"retrace.bundle","version":99,"root":"a","runs":["a"]}\n'),
    /bundle is version 99, and this retrace reads version 1/,
  );
});

test("a bundle whose header and body disagree is refused", () => {
  const header = '{"format":"retrace.bundle","version":1,"root":"a","runs":["a"],"complete":true}';

  assert.throws(
    () => parseBundle(`${header}\n{"run":"b","event":{"seq":0}}\n`),
    /bundle line 2 carries an event for "b", which its header does not list/,
  );
  assert.throws(
    () => parseBundle(`${header}\n{"event":{"seq":0}}\n`),
    /bundle line 2 is not a "run" and "event" pair/,
  );
  assert.throws(() => parseBundle(`${header}\n`), /bundle lists "a" and carries no events for it/);
  assert.throws(
    () =>
      parseBundle(
        '{"format":"retrace.bundle","version":1,"root":"a","runs":["b"],"complete":true}\n' +
          '{"run":"b","event":{"seq":0}}\n',
      ),
    /names "a" as its root and does not list it among its runs/,
  );
});

test("export writes a bundle the CLI can import somewhere verify then runs whole", async (t) => {
  const from = tempDir(t);
  const to = tempDir(t);
  const path = join(from, "lineage.jsonl");
  await chain(new RunStore(from), 2);

  const exported = capture();
  assert.equal(await main(["export", "fork-2", "--dir", from, "-o", path], exported), 0, exported.errors());
  assert.match(exported.text(), /3 runs, \d+ events/);
  assert.match(exported.text(), /2 runs of lineage, back to a run forked from nothing/);

  // The receiving end has never seen any of it, so verify has one hop to check.
  const alone = capture();
  handOver(from, to, "fork-2");
  assert.equal(await main(["verify", "fork-2", "--dir", to], alone), 0, alone.errors());
  assert.match(alone.text(), /verified as far as it goes/);

  const imported = capture();
  assert.equal(await main(["import", path, "--dir", to], imported), 0, imported.errors());
  assert.match(imported.text(), /3 runs: added baseline, fork-1; already here fork-2/);
  assert.match(imported.text(), /retrace verify fork-2 now has the runs it needs/);

  const verified = capture();
  assert.equal(await main(["verify", "fork-2", "--dir", to], verified), 0, verified.errors());
  assert.match(verified.text(), /ok {3}lineage/);
  assert.match(verified.text(), /verified: this log holds up against everything it claims/);
});

test("export says when the lineage it could reach stops short", async (t) => {
  const from = tempDir(t);
  const only = tempDir(t);
  await chain(new RunStore(from), 1);

  // fork-1 arrived on its own; exporting it can carry no more than it has.
  handOver(from, only, "fork-1");
  const io = capture();
  const code = await main(["export", "fork-1", "--dir", only, "-o", join(only, "b.jsonl")], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /the chain stops short: "baseline" is not in this store/);
});

test("export to stdout writes the bundle and nothing else", async (t) => {
  const dir = tempDir(t);
  await chain(new RunStore(dir), 0);
  const io = capture();

  assert.equal(await main(["export", "baseline", "--dir", dir, "-o", "-"], io), 0, io.errors());

  const bundle = parseBundle(io.text());
  assert.deepEqual(
    bundle.runs.map((r) => r.runId),
    ["baseline"],
  );
});

test("export and import without arguments say what they need", async (t) => {
  const dir = tempDir(t);
  const io = capture();

  assert.equal(await main(["export", "--dir", dir], io), 1);
  assert.match(io.errors(), /export needs a run id/);
  assert.equal(await main(["import", "--dir", dir], io), 1);
  assert.match(io.errors(), /import needs the path to a bundle/);
});
