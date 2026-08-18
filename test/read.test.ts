import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  ambientEffects,
  defineAgent,
  describeRead,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  recheckEvents,
  renderReport,
  replay,
  run,
  RunStore,
  summarize,
  text,
  tool,
  toolUse,
  verifyEvents,
  type RecordedRead,
  type RetraceEvent,
  type Tool,
  type ToolContext,
} from "../src/index.ts";

const agent = defineAgent({ name: "librarian", model: "claude-opus-5", maxSteps: 6 });

/**
 * A corpus that is not the network, not the clock and not the RNG — the shape
 * of thing `ctx.read` exists for. Nothing here wraps a global, because that is
 * the point: a driver like this is somewhere no wrapper reaches, and the only
 * way the journal learns of a read is the tool telling it.
 */
function corpus(rows: Record<string, string> = { alpha: "one", beta: "two" }) {
  const asked: string[] = [];
  return {
    asked,
    query(term: string): string {
      asked.push(term);
      return rows[term] ?? "nothing";
    },
  };
}

type Corpus = ReturnType<typeof corpus>;

function lookupTool(db: Corpus, via: "ctx" | "direct" = "ctx"): Tool {
  return tool({
    name: "lookup",
    description: "Look a term up in the corpus. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx: ToolContext) =>
      via === "ctx"
        ? await ctx.read("corpus", { term: input.term }, () => db.query(input.term))
        : db.query(input.term),
  });
}

/**
 * Two lookups in two steps, so a fork at step 1 replays one whole step and runs
 * the other live. A replayed tool call never executes, so the live tail is the
 * only place a tool body meets a value that came out of the log.
 */
function script(...terms: string[]) {
  const asked = terms.length > 0 ? terms : ["alpha", "beta"];
  return [
    ...asked.map((term, i) => ({ content: [toolUse(`t${i}`, "lookup", { term })] })),
    { content: [text("looked it up")] },
  ];
}

function reads(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => e.kind === "read");
}

async function record(options: { store?: RunStore; db?: Corpus; runId?: string } = {}) {
  const store = options.store ?? new MemoryStore();
  const db = options.db ?? corpus();
  const result = await run("look them up", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookupTool(db)],
    store,
    runId: options.runId ?? "read",
  });
  return { store, db, result };
}

test("a read a tool declared lands in the log, with the question it answered", async () => {
  const { db, result } = await record();

  assert.deepEqual(db.asked, ["alpha", "beta"]);
  const [recorded] = reads(result.events);
  assert.ok(recorded);
  assert.equal(recorded.step, 0);
  assert.match(recorded.key, /^step:0#0:lookup\/read:0:corpus:[0-9a-f]{12}$/);
  assert.equal(recorded.replayed, false);
  assert.deepEqual(recorded.value, {
    source: "corpus",
    question: { term: "alpha" },
    value: "one",
  });
  assert.equal(result.output, "looked it up");
});

test("a replay serves the recorded values and never reaches the source", async () => {
  const { store, result } = await record();

  // A fresh corpus that answers nothing: a replay that consulted it would come
  // back with different text rather than quietly passing against a stand-in
  // that happened to agree.
  const cold = corpus({});
  const again = await replay("read", {
    provider: new MockProvider([]),
    tools: [lookupTool(cold)],
    store,
  });

  assert.equal(again.status, "completed");
  assert.equal(again.output, result.output);
  assert.deepEqual(cold.asked, []);
  assert.deepEqual(
    reads(again.events).map((e) => e.replayed),
    [true, true],
  );
  assert.deepEqual(
    reads(again.events).map((e) => e.value),
    reads(result.events).map((e) => e.value),
  );
});

test("the live tail of a fork is served the value its parent recorded", async () => {
  const { store } = await record();

  // Step 1's lookup executes for real in this fork, and the corpus has moved
  // underneath it. A fork is supposed to differ from its parent in the thing
  // that was changed and nothing else, so the read still comes out of the log.
  const moved = corpus({ alpha: "ONE", beta: "TWO" });
  const forked = await fork("read", {
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "beta" })] },
      { content: [text("looked it up")] },
    ]),
    atStep: 1,
    tools: [lookupTool(moved)],
    store,
    runId: "read-forked",
  });

  assert.deepEqual(moved.asked, []);
  const [, second] = reads(forked.events);
  assert.ok(second);
  assert.equal(second.replayed, true);
  assert.deepEqual((second.value as RecordedRead).value, "two");
});

test("a live read asking something else finds no entry and consults the source", async () => {
  const { store } = await record();

  // Same slot — the first read of the step's only tool call — but a different
  // question. Serving the parent's answer here would be a wrong answer rather
  // than a stale one, which is what folding the question into the key prevents.
  const moved = corpus({ gamma: "three" });
  const forked = await fork("read", {
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "gamma" })] },
      { content: [text("looked it up")] },
    ]),
    atStep: 1,
    tools: [lookupTool(moved)],
    store,
    runId: "read-elsewhere",
  });

  assert.deepEqual(moved.asked, ["gamma"]);
  const [, second] = reads(forked.events);
  assert.ok(second);
  assert.equal(second.replayed, false);
  assert.deepEqual(second.value, {
    source: "corpus",
    question: { term: "gamma" },
    value: "three",
  });
});

test("a read that threw is recorded and throws again on replay", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const failing = tool({
    name: "lookup",
    description: "Look a term up in the corpus. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx: ToolContext) => {
      try {
        return await ctx.read("corpus", { term: input.term }, () => {
          attempts++;
          const error = new Error("corpus is down");
          error.name = "CorpusError";
          throw error;
        });
      } catch (cause) {
        return `unavailable: ${(cause as Error).name}: ${(cause as Error).message}`;
      }
    },
  });

  const result = await run("look them up", {
    agent,
    provider: new MockProvider(script("alpha")),
    tools: [failing],
    store,
    runId: "read-threw",
  });

  const [recorded] = reads(result.events);
  assert.deepEqual((recorded?.value as RecordedRead).error, {
    name: "CorpusError",
    message: "corpus is down",
  });
  // The tool caught the rejection, so the run itself completed; the effect is
  // the thing that failed, not the call around it.
  assert.equal(result.status, "completed");

  const again = await replay("read-threw", {
    provider: new MockProvider([]),
    tools: [failing],
    store,
  });

  assert.equal(attempts, 1);
  assert.deepEqual(
    againToolText(again.events),
    ["unavailable: CorpusError: corpus is down"],
  );
});

/** What each tool call in a log handed back to the model. */
function againToolText(events: readonly RetraceEvent[]): string[] {
  return effectsOf(events)
    .filter((e) => e.kind === "tool")
    .map((e) => (e.value as { content: string }).content);
}

test("reads are slotted by ordinal, so two sources in one call get two entries", async () => {
  const store = new MemoryStore();
  const db = corpus();
  const two = tool({
    name: "lookup",
    description: "Look a term up in the corpus. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx: ToolContext) => {
      const hit = await ctx.read("corpus", { term: input.term }, () => db.query(input.term));
      const twice = await ctx.read("corpus", { term: input.term }, () => db.query(input.term));
      const where = await ctx.read("shelf", null, () => "aisle 4");
      return `${hit}/${twice}/${where}`;
    },
  });

  const result = await run("look them up", {
    agent,
    provider: new MockProvider(script("alpha")),
    tools: [two],
    store,
    runId: "read-slots",
  });

  assert.deepEqual(
    reads(result.events).map((e) => e.key),
    [
      "step:0#0:lookup/read:0:corpus:" + slotOf(result.events, 0),
      "step:0#0:lookup/read:1:corpus:" + slotOf(result.events, 1),
      "step:0#0:lookup/read:2:shelf:" + slotOf(result.events, 2),
    ],
  );
  // Two reads asking the same source the same question still get two slots:
  // the ordinal is what makes them separate calls, and a tool that asks twice
  // is a tool that gets two answers back on a replay.
  assert.deepEqual(db.asked, ["alpha", "alpha"]);
  assert.deepEqual(againToolText(result.events), ["one/one/aisle 4"]);
});

/** The digest at the end of the nth recorded read's key. */
function slotOf(events: readonly RetraceEvent[], n: number): string {
  const key = reads(events)[n]?.key ?? "";
  return key.slice(key.lastIndexOf(":") + 1);
}

test("a read is not a fork point, because it resolves by key rather than position", async () => {
  const { store, result } = await record();
  const key = reads(result.events)[0]?.key ?? "";

  await assert.rejects(
    fork("read", {
      provider: new MockProvider([]),
      tools: [lookupTool(corpus())],
      atEffect: key,
      store,
      runId: "read-nope",
    }),
    /is a read inside "step:0#0:lookup", not a call/,
  );
});

test("an override replaces a read's answer and leaves the question it answered", async () => {
  const { store, result } = await record();
  const key = reads(result.events)[0]?.key ?? "";

  const forked = await fork("read", {
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "beta" })] },
      { content: [text("looked it up")] },
    ]),
    atStep: 1,
    tools: [lookupTool(corpus())],
    overrides: { [key]: "nothing at all" },
    store,
    runId: "read-what-if",
  });

  const [first] = reads(forked.events);
  assert.ok(first);
  assert.equal(first.overridden, true);
  assert.deepEqual(first.value, {
    source: "corpus",
    question: { term: "alpha" },
    value: "nothing at all",
  });
});

test("a read the journal covers is not reported as one that got around it", async () => {
  const store = new MemoryStore();
  const stamping = tool({
    name: "lookup",
    description: "Look a term up in the corpus. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    // The body reaches the ambient clock, but inside a read whose answer is
    // recorded — so what the log holds is reproducible, and marking the call as
    // having read a clock outside the journal would be false.
    run: async (input: { term: string }, ctx: ToolContext) =>
      await ctx.read("corpus", { term: input.term }, () => `filed at ${Date.now()}`),
  });

  const result = await run("look them up", {
    agent,
    provider: new MockProvider(script("alpha")),
    tools: [stamping],
    store,
    runId: "read-covers",
  });

  assert.deepEqual(ambientEffects(result.events), []);
  const audit = verifyEvents("read-covers", result.events, store);
  assert.equal(audit.checks.find((c) => c.name === "ambient")?.status, "ok");
  assert.equal(audit.ok, true);
});

test("a fork whose prefix carries reads verifies against the run it came from", async () => {
  const { store } = await record();
  await fork("read", {
    provider: new MockProvider([
      { content: [toolUse("t1", "lookup", { term: "beta" })] },
      { content: [text("looked it up")] },
    ]),
    atStep: 1,
    tools: [lookupTool(corpus())],
    store,
    runId: "read-verified",
  });

  const audit = verifyEvents("read-verified", store.read("read-verified"), store);
  const failing = audit.checks.filter((c) => c.status === "fail");
  assert.deepEqual(failing, []);
  // The reads in the replayed prefix are the parent's, value for value — which
  // is the claim a free prefix makes and the one `parent` exists to check.
  assert.equal(audit.checks.find((c) => c.name === "parent")?.status, "ok");
  assert.equal(audit.ok, true);
});

test("recheck does not serve a read from the log — asking again is what it is for", async () => {
  const { store, result } = await record();

  const moved = corpus({ alpha: "ONE", beta: "TWO" });
  const report = await recheckEvents("read", result.events, { tools: [lookupTool(moved)], store });

  assert.deepEqual(moved.asked, ["alpha", "alpha", "beta", "beta"]);
  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["moved", "moved"],
  );
  assert.equal(report.ok, false);
});

test("a run whose reads still agree rechecks clean", async () => {
  const { store, db, result } = await record();

  const report = await recheckEvents("read", result.events, { tools: [lookupTool(db)], store });

  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["same", "same"],
  );
  assert.equal(report.ok, true);
});

test("parallel tool calls slot their reads by key, whatever order they finished in", async () => {
  const store = new MemoryStore();
  const db = corpus({ alpha: "one", beta: "two" });
  const slow = tool({
    name: "lookup",
    description: "Look a term up in the corpus. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx: ToolContext) => {
      // The first call asked for waits longest, so the batch finishes in the
      // reverse of the order the model asked in.
      await new Promise((resolve) => setTimeout(resolve, input.term === "alpha" ? 20 : 1));
      return await ctx.read("corpus", { term: input.term }, () => db.query(input.term));
    },
  });

  const result = await run("look them up", {
    agent: defineAgent({ name: "librarian", model: "claude-opus-5", parallelTools: true }),
    provider: new MockProvider([
      { content: [toolUse("t0", "lookup", { term: "alpha" }), toolUse("t1", "lookup", { term: "beta" })] },
      { content: [text("looked it up")] },
    ]),
    tools: [slow],
    store,
    runId: "read-parallel",
  });

  assert.deepEqual(
    reads(result.events).map((e) => e.key.split("/")[0]),
    ["step:0#0:lookup", "step:0#1:lookup"],
  );
  assert.deepEqual(
    reads(result.events).map((e) => (e.value as RecordedRead).value),
    ["one", "two"],
  );

  const again = await replay("read-parallel", {
    provider: new MockProvider([]),
    tools: [slow],
    store,
  });
  assert.equal(again.status, "completed");
  assert.deepEqual(againToolText(again.events), ["one", "two"]);
});

test("show and the report say what each read asked and what came back", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { result } = await record({ store: new RunStore(dir) });

  const html = renderReport(summarize("read", result.events), result.events);
  assert.ok(html.includes("corpus {&quot;term&quot;:&quot;alpha&quot;} → one"));

  const out: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  assert.equal(await main(["show", "read", "--dir", dir], io), 0);
  // Colour codes sit between every field, so the line is read for its content.
  const shown = out.join("").replaceAll(/\[\d+m/g, "");
  assert.match(shown, /read {3}step:0#0:lookup\/read:0:corpus:[0-9a-f]{12}/);
  assert.match(shown, /→ corpus \{"term":"alpha"\} → one/);
});

test("describeRead says the source, the question and the answer, or why there wasn't one", () => {
  assert.equal(
    describeRead({ source: "corpus", question: { term: "alpha" }, value: "one" }),
    'corpus {"term":"alpha"} → one',
  );
  assert.equal(describeRead({ source: "shelf", question: null, value: "aisle 4" }), "shelf → aisle 4");
  assert.equal(
    describeRead({ source: "corpus", question: null, error: { name: "CorpusError", message: "down" } }),
    "corpus → CorpusError: down",
  );
});

test("a tool that reads its corpus directly is the case ctx.read exists to fix", async () => {
  const store = new MemoryStore();
  const db = corpus();
  await run("look them up", {
    agent,
    provider: new MockProvider(script("alpha")),
    tools: [lookupTool(db, "direct")],
    store,
    runId: "read-direct",
  });

  const moved = corpus({ alpha: "ONE" });
  const again = await replay("read-direct", {
    provider: new MockProvider([]),
    tools: [lookupTool(moved, "direct")],
    store,
  });

  // The replay reproduces, because the *tool call* is served from the log and
  // never executes — but nothing here says the answer is one the tool would
  // give again, and the live tail of a fork would consult the moved corpus.
  assert.equal(again.status, "completed");
  assert.deepEqual(reads(again.events), []);

  const report = await recheckEvents("read-direct", again.events, {
    tools: [lookupTool(moved, "direct")],
    store,
  });
  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["moved"],
  );
});
