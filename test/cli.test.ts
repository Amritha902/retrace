import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  inspect,
  loadRunModule,
  MockProvider,
  objectSchema,
  run,
  RunStore,
  text,
  tool,
  toolUse,
} from "../src/index.ts";
import { calls } from "./fixtures/agent-module.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/agent-module.ts", import.meta.url));
const DEFAULT_EXPORT = fileURLToPath(new URL("./fixtures/default-module.ts", import.meta.url));
const BROKEN = fileURLToPath(new URL("./fixtures/broken-module.ts", import.meta.url));

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are a researcher.",
  maxSteps: 6,
});

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

/** A store directory that cleans itself up when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function record(dir: string): Promise<void> {
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store: new RunStore(dir),
    runId: "baseline",
  });
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

test("replay re-runs a log with no module at all, and says it reproduced", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const io = capture();

  const code = await main(["replay", "baseline", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /reproduced 5 effects, identical/);
  assert.doesNotMatch(io.text(), /\blive\b/, "every effect must come from the log");
});

test("replay with a module reaches neither the provider nor the tools", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const before = calls.length;
  const io = capture();

  const code = await main(["replay", "baseline", "--dir", dir, "--module", FIXTURE], io);

  assert.equal(code, 0, io.errors());
  assert.deepEqual(calls.slice(before), [], "a replay must not execute anything");
  assert.match(io.text(), /reproduced/);
});

test("replay writes its own run, leaving the original alone", async (t) => {
  const dir = tempDir(t);
  await record(dir);

  await main(["replay", "baseline", "--dir", dir], capture());

  const store = new RunStore(dir);
  const ids = store.list();
  assert.equal(ids.length, 2);
  const replayed = ids.find((id) => id !== "baseline") ?? "";
  const summary = inspect(replayed, store);
  assert.deepEqual(summary.forkedFrom, { runId: "baseline", atStep: "all" });
  assert.equal(summary.totals?.billedUsd, 0, "a replay spends nothing");
});

test("replay reports a log that stops short of the run it recorded", async (t) => {
  const dir = tempDir(t);
  await record(dir);

  // Keep step 0 and throw the rest away, the way a crash mid-run would.
  const store = new RunStore(dir);
  for (const event of store.read("baseline")) {
    if (event.type === "effect" && event.index >= 2) continue;
    if (event.type === "run.finished") continue;
    store.append("truncated", event);
  }

  const io = capture();
  const code = await main(["replay", "truncated", "--dir", dir], io);

  assert.equal(code, 1);
  assert.match(io.text(), /replay needed a live model call/);
  assert.match(io.text(), /--module/, "the error says how to carry on past the log");
});

test("fork replays the prefix and executes from --at onward", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const before = calls.length;
  const io = capture();

  const code = await main(["fork", "baseline", "--at", "2", "--dir", dir, "--module", FIXTURE], io);

  assert.equal(code, 0, io.errors());
  assert.deepEqual(
    calls.slice(before),
    ["model:Answer in one sentence."],
    "only step 2 runs live, and it sees the module's system prompt",
  );
  assert.match(io.text(), /live answer, system was "Answer in one sentence\."/);

  const store = new RunStore(dir);
  const forked = store.list().find((id) => id !== "baseline") ?? "";
  const summary = inspect(forked, store);
  assert.deepEqual(summary.forkedFrom, { runId: "baseline", atStep: 2 });
  assert.equal(summary.agent.model, agent.model, "unchanged fields come from the parent");
  assert.ok((summary.totals?.savedUsd ?? 0) > 0);
});

test("fork at step 0 replays nothing and takes the input from the log", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const before = calls.length;
  const io = capture();

  const code = await main(["fork", "baseline", "--at", "0", "--dir", dir, "--module", FIXTURE], io);

  assert.equal(code, 0, io.errors());
  assert.equal(calls.slice(before).length, 1, "step 0 answers outright, so nothing else runs");
  assert.doesNotMatch(io.text(), /replayed/);
});

test("replay reproduces a run whose tools stamped the time and an id", async (t) => {
  const dir = tempDir(t);
  const stamp = tool({
    name: "stamp",
    description: "File a record. Call this to record that something happened.",
    inputSchema: objectSchema({}),
    run: async (_input: unknown, ctx) => `${await ctx.now()} ${await ctx.uuid()}`,
  });
  await run("file it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", {})] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store: new RunStore(dir),
    runId: "stamped",
  });

  const io = capture();
  assert.equal(await main(["replay", "stamped", "--dir", dir], io), 0, io.errors());
  // model, tool, clock, uuid, model — the tool's reads are part of the log.
  assert.match(io.text(), /reproduced 5 effects, identical/);
  assert.match(io.text(), /replayed {2}clock {2}step:0#0:stamp\/clock:0/);
});

test("fork says which argument it is missing", async (t) => {
  const dir = tempDir(t);
  await record(dir);

  const noStep = capture();
  assert.equal(await main(["fork", "baseline", "--dir", dir, "--module", FIXTURE], noStep), 1);
  assert.match(noStep.errors(), /--at <step>/);

  const noModule = capture();
  assert.equal(await main(["fork", "baseline", "--at", "2", "--dir", dir], noModule), 1);
  assert.match(noModule.errors(), /--module <path>/);

  const badStep = capture();
  const args = ["fork", "baseline", "--at", "two", "--dir", dir, "--module", FIXTURE];
  assert.equal(await main(args, badStep), 1);
  assert.match(badStep.errors(), /--at takes a step number, got "two"/);
});

test("an option with no value is an error, not a silent default", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const io = capture();

  assert.equal(await main(["replay", "baseline", "--dir", dir, "--module"], io), 1);
  assert.match(io.errors(), /--module needs a value/);
});

test("--on-divergence only takes the two policies that exist", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const io = capture();

  assert.equal(await main(["replay", "baseline", "--dir", dir, "--on-divergence", "maybe"], io), 1);
  assert.match(io.errors(), /--on-divergence takes "strict" or "live"/);
});

test("a missing run is an error message, not a stack trace", async (t) => {
  const dir = tempDir(t);
  const io = capture();

  assert.equal(await main(["replay", "nonesuch", "--dir", dir], io), 1);
  assert.match(io.errors(), /no run "nonesuch"/);
  assert.doesNotMatch(io.errors(), /at Object\./);
});

test("show marks a fork's replayed prefix and its live steps apart", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  await main(["fork", "baseline", "--at", "2", "--dir", dir, "--module", FIXTURE], capture());
  const forked = new RunStore(dir).list().find((id) => id !== "baseline") ?? "";

  const io = capture();
  assert.equal(await main(["show", forked, "--dir", dir], io), 0);
  // The kind column is six wide so "random" lines up with the rest.
  assert.match(io.text(), /replayed {2}model {2}step:0/);
  assert.match(io.text(), /replayed {2}tool {3}step:0#0:lookup/);
  assert.match(io.text(), /live {6}model {2}step:2/);
  assert.match(io.text(), /forked from baseline at step 2/);
});

test("a module can arrive as a default export", async () => {
  const mod = await loadRunModule(DEFAULT_EXPORT);
  assert.equal(mod.tools?.length, 1);
  assert.equal(mod.tools?.[0]?.name, "lookup");
  assert.deepEqual(mod.agent, { system: "From the default export." });
});

test("loading a module names what is wrong with it", async () => {
  await assert.rejects(loadRunModule(BROKEN), /tool named "lookup" with no run function/);
  await assert.rejects(loadRunModule("./no/such/module.ts"), /cannot load module/);
});
