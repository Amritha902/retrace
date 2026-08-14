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
  IrreversibleToolError,
  MemoryStore,
  MockProvider,
  objectSchema,
  recheckRun,
  replay,
  resume,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  type RetraceEvent,
  type Tool,
} from "../src/index.ts";
import { sent } from "./fixtures/irreversible-module.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/irreversible-module.ts", import.meta.url));

const agent = defineAgent({ name: "courier", model: "claude-opus-5", maxSteps: 6 });

/** The pair of tools every test here uses: one that reads, one that cannot be undone. */
function tools(): { tools: Tool[]; lookups: () => number; sends: () => number } {
  let lookups = 0;
  let sends = 0;
  return {
    lookups: () => lookups,
    sends: () => sends,
    tools: [
      tool({
        name: "lookup",
        description: "Look a term up. Call this when you need a fact you don't have.",
        inputSchema: objectSchema({ term: { type: "string" } }),
        run: (input: { term: string }) => {
          lookups++;
          return `definition of ${input.term}`;
        },
      }),
      tool({
        name: "send_email",
        description: "Send an email. Call this once the answer is ready to go out.",
        inputSchema: objectSchema({ to: { type: "string" } }),
        irreversible: true,
        run: (input: { to: string }) => {
          sends++;
          return `sent to ${input.to}`;
        },
      }),
    ],
  };
}

/** Look something up, mail the answer, then say so. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "send_email", { to: "reader@example.com" })] },
  { content: [text("looked up and sent")] },
];

/** What the model says when a fork re-asks for step 1: send the mail again. */
const mailAgain = () => [
  { content: [toolUse("t2", "send_email", { to: "reader@example.com" })] },
  { content: [text("looked up and sent")] },
];

async function record(store: MemoryStore, runId = "baseline") {
  const t = tools();
  const result = await run("look alpha up and mail it", {
    agent,
    provider: new MockProvider(script()),
    tools: t.tools,
    store,
    runId,
  });
  return { result, ...t };
}

test("a fresh run executes an irreversible tool like any other", async () => {
  const store = new MemoryStore();
  const baseline = await record(store);

  assert.equal(baseline.result.status, "completed");
  assert.equal(baseline.sends(), 1, "nothing is being repeated, so there is nothing to refuse");
  assert.equal(baseline.lookups(), 1);
});

test("a fork refuses to send the mail a second time, and names the call", async () => {
  const store = new MemoryStore();
  await record(store);

  const t = tools();
  const forked = await fork("baseline", {
    provider: new MockProvider(mailAgain()),
    atStep: 1,
    tools: t.tools,
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "failed");
  assert.equal(t.sends(), 0, "the point of the message is that the mail was not sent");
  assert.match(forked.error ?? "", /"send_email" is marked irreversible/);
  assert.match(forked.error ?? "", /step:1#0:send_email/);
  // The way out that keeps the run: fork above it and the call replays.
  assert.match(forked.error ?? "", /Fork at step 2 or later/);
  assert.match(forked.error ?? "", /--allow-irreversible/);
});

test("nothing of the refused step reaches the log, because nothing of it happened", async () => {
  const store = new MemoryStore();
  await record(store);

  await fork("baseline", {
    provider: new MockProvider(mailAgain()),
    atStep: 1,
    tools: tools().tools,
    store,
    runId: "forked",
  });

  const effects = effectsOf(store.read("forked"));
  assert.deepEqual(
    effects.map((e) => e.key),
    ["step:0", "step:0#0:lookup", "step:1"],
    "the replayed prefix and the live model turn, and then it stops",
  );
});

test("a call the log answers is not a second execution, so it replays untouched", async () => {
  const store = new MemoryStore();
  const baseline = await record(store);

  const t = tools();
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("a different ending")] }]),
    atStep: 2,
    tools: t.tools,
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "completed");
  assert.equal(forked.output, "a different ending");
  assert.equal(t.sends(), 0, "step 1 came out of the log, so nothing was sent");
  assert.equal(forked.totals.savedUsd, baseline.result.totals.costUsd - forked.totals.billedUsd);
});

test("allowIrreversible is how you say you meant it", async () => {
  const store = new MemoryStore();
  await record(store);

  const t = tools();
  const forked = await fork("baseline", {
    provider: new MockProvider(mailAgain()),
    atStep: 1,
    tools: t.tools,
    store,
    runId: "forked",
    allowIrreversible: true,
  });

  assert.equal(forked.status, "completed");
  assert.equal(t.sends(), 1);
});

test("a full replay executes nothing, so there is nothing to refuse", async () => {
  const store = new MemoryStore();
  const baseline = await record(store);

  const t = tools();
  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: t.tools,
    store,
    runId: "replayed",
  });

  assert.equal(replayed.status, "completed");
  assert.equal(replayed.output, baseline.result.output);
  assert.equal(t.sends(), 0);
});

/**
 * Copy a log up to its `keep`th effect and stop, the way a killed process leaves
 * one behind — no `run.finished`, and what it was doing next simply not written.
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

test("a resume refuses the call the run died on when that call cannot be repeated", async () => {
  const store = new MemoryStore();
  await record(store);
  // Effects 0-2 are step 0 whole and step 1's model turn; the send it asked for
  // never reached disk, which is exactly the case the caveat warns about — a
  // tool that may have done its work before the process went away.
  writeTruncated(store, "baseline", "killed", 3);

  const t = tools();
  const resumed = await resume("killed", {
    provider: new MockProvider([{ content: [text("looked up and sent")] }]),
    tools: t.tools,
    store,
    runId: "resumed",
  });

  assert.equal(resumed.status, "failed");
  assert.equal(t.sends(), 0);
  assert.match(resumed.error ?? "", /"send_email" is marked irreversible/);
});

test("the whole live tail is refused, so the harmless call beside it does not run", async () => {
  const store = new MemoryStore();
  const both = [toolUse("t1", "lookup", { term: "alpha" }), toolUse("t2", "send_email", { to: "r" })];
  const t = tools();
  await run("look alpha up and mail it", {
    agent,
    provider: new MockProvider([{ content: both }, { content: [text("done")] }]),
    tools: t.tools,
    store,
    runId: "baseline",
  });

  const again = tools();
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: both }, { content: [text("done")] }]),
    atStep: 0,
    tools: again.tools,
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "failed");
  assert.equal(again.sends(), 0);
  assert.equal(again.lookups(), 0, "a step that cannot finish should not half-start");
});

test("the same holds when the step runs its tools at once", async () => {
  const store = new MemoryStore();
  const parallel = defineAgent({ ...agent, parallelTools: true });
  const both = [toolUse("t1", "lookup", { term: "alpha" }), toolUse("t2", "send_email", { to: "r" })];
  const t = tools();
  await run("look alpha up and mail it", {
    agent: parallel,
    provider: new MockProvider([{ content: both }, { content: [text("done")] }]),
    tools: t.tools,
    store,
    runId: "baseline",
  });

  const again = tools();
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: both }, { content: [text("done")] }]),
    atStep: 0,
    tools: again.tools,
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "failed");
  assert.equal(again.sends(), 0);
  assert.equal(again.lookups(), 0);
});

test("a tool the module no longer marks is executed, because the mark is the claim", async () => {
  const store = new MemoryStore();
  await record(store);

  // Same name, same schema, no mark: the runtime is enforcing what the tool
  // says about itself today, not something it remembers from the log.
  const plain = tool({
    name: "send_email",
    description: "Send an email. Call this once the answer is ready to go out.",
    inputSchema: objectSchema({ to: { type: "string" } }),
    run: () => "sent",
  });

  const forked = await fork("baseline", {
    provider: new MockProvider(mailAgain()),
    atStep: 1,
    tools: [plain],
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "completed");
});

test("tool() carries the mark through to the tool it builds", () => {
  const marked = tool({
    name: "charge",
    description: "Take payment.",
    inputSchema: objectSchema({ amount: { type: "string" } }),
    irreversible: true,
    run: () => "charged",
  });
  const plain = tool({
    name: "search",
    description: "Search.",
    inputSchema: objectSchema({ q: { type: "string" } }),
    run: () => "results",
  });

  assert.equal(marked.irreversible, true);
  assert.equal(plain.irreversible, undefined);
  // Never part of the schema: the model is not shown it, and the tool
  // declarations the log records are what `stale (tools)` compares.
  assert.equal("irreversible" in declaredBy(marked), false);
});

/** The tool exactly as a run records it — name, description, schema, no more. */
function declaredBy(t: Tool): Record<string, unknown> {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

test("the tools a run declares are unchanged by the mark", async () => {
  const store = new MemoryStore();
  await record(store);

  const started = store.read("baseline").find((e) => e.type === "run.started");
  assert.ok(started?.type === "run.started");
  assert.deepEqual(
    started.tools?.map((t) => Object.keys(t).sort()),
    [
      ["description", "inputSchema", "name"],
      ["description", "inputSchema", "name"],
    ],
  );
});

test("recheck holds an irreversible call back rather than making it again", async () => {
  const store = new MemoryStore();
  await record(store);

  const t = tools();
  const report = await recheckRun("baseline", { tools: t.tools, store });

  assert.equal(t.sends(), 0);
  assert.equal(t.lookups(), 1, "the tool that only reads is asked again");
  assert.equal(report.calls.find((c) => c.tool === "send_email")?.status, "irreversible");
  assert.equal(report.calls.find((c) => c.tool === "lookup")?.status, "same");
  assert.equal(report.ok, true, "held back is not a finding about the world");
  assert.equal(report.complete, false, "but the run is not fully re-checked either");
});

test("naming an irreversible tool with --tool is not consent to run it", async () => {
  const store = new MemoryStore();
  await record(store);

  const t = tools();
  const report = await recheckRun("baseline", { tools: t.tools, store, only: ["send_email"] });

  assert.equal(t.sends(), 0);
  assert.equal(report.calls.find((c) => c.tool === "send_email")?.status, "irreversible");
  assert.equal(report.calls.find((c) => c.tool === "lookup")?.status, "skipped");
});

test("recheck runs it when told to, and compares it like anything else", async () => {
  const store = new MemoryStore();
  await record(store);

  const t = tools();
  const report = await recheckRun("baseline", {
    tools: t.tools,
    store,
    allowIrreversible: true,
  });

  assert.equal(t.sends(), 1);
  assert.equal(report.calls.find((c) => c.tool === "send_email")?.status, "same");
  assert.equal(report.complete, true);
});

test("IrreversibleToolError carries the tool and the call it would have made", () => {
  const error = new IrreversibleToolError("send_email", "step:1#0:send_email", 1);
  assert.equal(error.toolName, "send_email");
  assert.equal(error.effectKey, "step:1#0:send_email");
  assert.match(error.message, /Fork at step 2 or later/);
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-irreversible-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string } {
  let out = "";
  let err = "";
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    text: () => (out + err).replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

/** A run on disk for the CLI to re-enter, recorded with the fixture's tools. */
async function recordOnDisk(t: TestContext, dir: string): Promise<void> {
  sent.length = 0;
  t.after(() => void (sent.length = 0));
  const store = new RunStore(dir);
  const local = tools();
  await run("look alpha up and mail it", {
    agent,
    provider: new MockProvider(script()),
    tools: local.tools,
    store,
    runId: "baseline",
  });
}

test("the CLI stops a fork at the call it would have repeated", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  // The fork point recheck leaves you holding: re-enter at the one call, keeping
  // the turn that asked for it. Here that call is the one that cannot be undone.
  const code = await main(
    ["fork", "baseline", "--at", "step:1#0:send_email", "--dir", dir, "--module", FIXTURE],
    io,
  );

  assert.equal(code, 1);
  assert.deepEqual(sent, [], "the mail was not sent");
  assert.match(io.text(), /"send_email" is marked irreversible/);
});

test("the CLI runs it when --allow-irreversible says so", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(
    [
      "fork",
      "baseline",
      "--at",
      "step:1#0:send_email",
      "--dir",
      dir,
      "--module",
      FIXTURE,
      "--allow-irreversible",
    ],
    io,
  );

  assert.equal(code, 0);
  assert.deepEqual(sent, ["reader@example.com"]);
});

test("the CLI marks a held call in recheck's timeline and in what it did not check", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(["recheck", "baseline", "--dir", dir, "--module", FIXTURE], io);

  assert.equal(code, 0, "holding a call back is not a failed check");
  assert.deepEqual(sent, []);
  assert.match(io.text(), /held\s+step:1#0:send_email/);
  assert.match(io.text(), /still true as far as it goes: 1 of 2/);
  assert.match(io.text(), /1 call a tool marked irreversible, which was held back/);
});

test("a run of only irreversible calls is re-checked by --allow-irreversible", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(
    ["recheck", "baseline", "--dir", dir, "--module", FIXTURE, "--allow-irreversible"],
    io,
  );

  assert.equal(code, 0);
  assert.deepEqual(sent, ["reader@example.com"]);
  assert.match(io.text(), /still true: all 2 recorded tool calls return what the log holds/);
});

test("the flag is consumed, so it never lands where a run id is read", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(["show", "--allow-irreversible", "baseline", "--dir", dir], io);

  assert.equal(code, 0);
  assert.match(io.text(), /step 0/);
});

/** Nothing above reads this, but a log that cannot be read back is not a log. */
test("a refused fork leaves a log that still reads as a run", async () => {
  const store = new MemoryStore();
  await record(store);
  await fork("baseline", {
    provider: new MockProvider(mailAgain()),
    atStep: 1,
    tools: tools().tools,
    store,
    runId: "forked",
  });

  const events: readonly RetraceEvent[] = store.read("forked");
  const finished = events.find((e) => e.type === "run.finished");
  assert.ok(finished?.type === "run.finished");
  assert.equal(finished.status, "failed");
  // It got as far as asking the model, and no further: the one live turn is
  // billed, the replayed prefix is not, and the totals still add up.
  assert.ok(finished.totals.billedUsd > 0);
  assert.ok(finished.totals.savedUsd > 0);
  assert.equal(finished.totals.costUsd, finished.totals.billedUsd + finished.totals.savedUsd);
});
