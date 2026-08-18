import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  fork,
  inspect,
  lineageTrees,
  MockProvider,
  objectSchema,
  replay,
  resume,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  walk,
  type RetraceEvent,
} from "../src/index.ts";

const agent = defineAgent({
  name: "analyst",
  model: "claude-opus-5",
  system: "You are a research analyst.",
  maxSteps: 6,
});

const search = tool({
  name: "search",
  description: "Search the corpus. Call this when the answer depends on a fact you were not given.",
  inputSchema: objectSchema({ query: { type: "string" } }),
  run: (input: { query: string }) => `3 results for "${input.query}"`,
});

/** Two searches, then an answer: three steps, five effects. */
const script = () => [
  { content: [toolUse("t1", "search", { query: "market size" })] },
  { content: [toolUse("t2", "search", { query: "competitors" })] },
  { content: [text("Large market. Crowded. Per-seat pricing.")] },
];

const said = (answer: string) => new MockProvider([{ content: [text(answer)] }]);

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function record(dir: string, runId = "original"): Promise<void> {
  await run("Analyse the note-taking app market.", {
    agent,
    provider: new MockProvider(script()),
    tools: [search],
    store: new RunStore(dir),
    runId,
  });
}

/**
 * The shape the whole runtime is for: one run, re-entered several ways. A fork
 * that rewrites the prompt, a counterfactual that replaces what a tool said, a
 * fork of that fork, and the replay that checked the original reproduces.
 */
async function family(dir: string): Promise<RunStore> {
  const store = new RunStore(dir);
  await record(dir);
  await fork("original", {
    provider: said("Large market. Crowded."),
    tools: [search],
    atStep: 2,
    agent: { system: "Answer in at most ten words." },
    store,
    runId: "fork-a",
  });
  await fork("original", {
    provider: said("Nothing in the corpus."),
    tools: [search],
    atStep: 2,
    overrides: { "step:0#0:search": "no results" },
    store,
    runId: "fork-b",
  });
  await fork("fork-a", {
    provider: said("Crowded, per-seat."),
    tools: [search],
    atEffect: "step:1#0:search",
    agent: { system: "Five words." },
    store,
    runId: "fork-c",
  });
  await replay("original", {
    provider: said("unreachable"),
    tools: [search],
    store,
    runId: "checked",
  });
  return store;
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

test("a family is every run made from a run, hung off the one it came from", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);

  const { trees } = lineageTrees(store, "fork-c");

  assert.equal(trees.length, 1, "one family, however far down it was asked about");
  const root = trees[0]?.root;
  assert.equal(root?.runId, "original", "asking about a fork of a fork reaches the run it came from");
  assert.deepEqual(
    root?.children.map((c) => c.runId),
    ["fork-a", "fork-b", "checked"],
    "the runs made from it, oldest first",
  );
  assert.deepEqual(
    root?.children[0]?.children.map((c) => c.runId),
    ["fork-c"],
    "a fork of a fork hangs off the fork, not off the run at the top",
  );
  assert.deepEqual([...walk(root!)].map((n) => n.runId), [
    "original",
    "fork-a",
    "fork-c",
    "fork-b",
    "checked",
  ]);
});

test("each run carries what it asked that the run above it didn't", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);

  const { trees } = lineageTrees(store, "original");
  const by = new Map([...walk(trees[0]!.root)].map((n) => [n.runId, n]));

  assert.equal(by.get("original")?.reentry, undefined, "the run at the top came from nothing");
  assert.deepEqual(by.get("fork-a")?.reentry, { kind: "fork", at: "step 2" });
  assert.deepEqual(by.get("fork-c")?.reentry, { kind: "fork", at: "step:1#0:search" });
  assert.deepEqual(by.get("checked")?.reentry, { kind: "replay" });

  assert.deepEqual(by.get("fork-a")?.moved, ["system"], "a rewritten prompt moves the system prompt");
  assert.deepEqual(by.get("fork-b")?.set, ["step:0#0:search"]);
  assert.deepEqual(
    by.get("fork-b")?.moved,
    ["conversation"],
    "a substituted tool result moves what the replayed steps were told, not who was asking",
  );
  assert.deepEqual(by.get("checked")?.moved, [], "a replay of a run rebuilds the same requests");
});

test("a resumed run hangs off the run it picked up from, and says how far in", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await record(dir);

  // Step 0 whole, then step 1's model call: what a killed process leaves.
  for (const event of store.read("original")) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && event.index >= 3) break;
    store.append("killed", event);
  }
  await resume("killed", {
    provider: new MockProvider(script().slice(2)),
    tools: [search],
    store,
    runId: "carried-on",
  });

  const { trees } = lineageTrees(store, "carried-on");

  const carried = trees.find((t) => t.root.runId === "killed")?.root.children[0];
  assert.deepEqual(carried?.reentry, { kind: "resume", after: 3, parentStatus: "running" });
});

test("the family starts where the store does, and names the run above it", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);
  const alone = tempDir(t);
  mkdirSync(join(alone, "runs"), { recursive: true });
  copyFileSync(join(store.dir, "fork-a.jsonl"), join(alone, "runs", "fork-a.jsonl"));

  const { trees } = lineageTrees(new RunStore(alone), "fork-a");

  assert.equal(trees[0]?.root.runId, "fork-a");
  assert.equal(
    trees[0]?.before,
    "original",
    "a fork read where its parent isn't says which run the family is missing",
  );
  assert.equal(lineageTrees(store, "fork-a").trees[0]?.before, undefined);
});

test("a family's totals are what it cost and what it never paid twice", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);

  const tree = lineageTrees(store, "original").trees[0]!;

  const ids = ["original", "fork-a", "fork-b", "fork-c", "checked"];
  const summaries = ids.map((id) => inspect(id, store));
  assert.equal(tree.runs, ids.length);
  assert.equal(
    tree.billedUsd,
    summaries.reduce((sum, s) => sum + (s.totals?.billedUsd ?? 0), 0),
  );
  assert.equal(
    tree.savedUsd,
    summaries.reduce((sum, s) => sum + (s.totals?.savedUsd ?? 0), 0),
  );
  assert.ok(tree.savedUsd > 0, "four re-entries into one run save something");
});

test("with no run id, every family in the store", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);
  await record(dir, "unrelated");

  const { trees } = lineageTrees(store);

  assert.deepEqual(
    trees.map((t) => t.root.runId),
    ["original", "unrelated"],
    "two runs nothing connects are two families, oldest first",
  );
  assert.deepEqual(
    trees.map((t) => t.runs),
    [5, 1],
  );
});

test("a log that cannot be read belongs to no family, and is named rather than dropped", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);
  writeFileSync(join(store.dir, "shredded.jsonl"), "{not json\n{}\n", "utf8");

  const { trees, unreadable } = lineageTrees(store);

  assert.deepEqual(unreadable, ["shredded"]);
  assert.deepEqual(trees.map((t) => t.root.runId), ["original"]);
  assert.throws(
    () => lineageTrees(store, "shredded"),
    /corrupt event/,
    "asked about that run by name, the unreadable log is the answer, not a silence",
  );
});

test("a log naming itself as its parent is placed once rather than endlessly", async (t) => {
  const dir = tempDir(t);
  const store = await family(dir);
  for (const event of store.read("original")) {
    const doctored: RetraceEvent =
      event.type === "run.started"
        ? { ...event, runId: "ouroboros", forkedFrom: { runId: "ouroboros", atStep: 1 } }
        : event;
    store.append("ouroboros", doctored);
  }

  const { trees } = lineageTrees(store, "ouroboros");

  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.root.runId, "ouroboros");
  assert.deepEqual(trees[0]?.root.children, []);
});

test("the CLI draws the family and adds up what it spent", async (t) => {
  const dir = tempDir(t);
  await family(dir);
  const io = capture();

  const code = await main(["tree", "fork-a", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  const text = io.text();
  assert.match(text, /original {2}completed {2}recorded from scratch/);
  assert.match(text, /├─ fork-a {2}completed {2}fork at step 2 · system/);
  assert.match(text, /└─ fork-c {2}completed {2}fork at step:1#0:search · system/);
  assert.match(text, /fork-b {2}completed {2}fork at step 2 · set step:0#0:search · conversation/);
  assert.match(text, /checked {2}completed {2}replay/);
  assert.match(text, /Large market\. Crowded\. Per-seat pricing\./, "each run's answer is on it");
  assert.match(text, /5 runs · \$.* billed · \$.* not paid a second time/);
});

test("the CLI says when a store has nothing in it, and when a run isn't in it", async (t) => {
  const dir = tempDir(t);
  const empty = capture();

  assert.equal(await main(["tree", "--dir", dir], empty), 0);
  assert.match(empty.text(), /no runs in/);

  const missing = capture();
  assert.equal(await main(["tree", "nobody", "--dir", dir], missing), 1);
  assert.match(missing.errors(), /no run "nobody"/);
});
