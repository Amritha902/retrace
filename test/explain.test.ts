import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  explainStale,
  explainStaleEvents,
  EXPLAINED_FACETS,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  REQUEST_FACETS,
  replay,
  run,
  RunStore,
  staleEffects,
  text,
  tool,
  TOOL_FACETS,
  toolUse,
  type RetraceEvent,
  type StaleChange,
} from "../src/index.ts";

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 6,
});

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

const summarise = tool({
  name: "summarise",
  description: "Summarise a passage. Call this when the answer is long.",
  inputSchema: objectSchema({ passage: { type: "string" } }),
  run: (input: { passage: string }) => `short: ${input.passage}`,
});

/** Two lookups, then an answer: three steps, five effects. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

async function recordBaseline(store: MemoryStore) {
  return run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
}

/** A live turn for whatever the fork asks after its replayed prefix runs out. */
const answer = () => new MockProvider([{ content: [text("a shorter answer")] }]);

function only(changes: readonly StaleChange[], facet: string): StaleChange[] {
  return changes.filter((c) => c.facet === facet);
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

test("a rewritten prompt comes back as the two prompts, not just the word system", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    agent: { system: "You are terse. Answer in five words." },
    store,
    runId: "forked",
  });

  const report = explainStale("forked", store);
  assert.equal(report.parentRunId, "baseline");
  assert.equal(report.staleEffects, staleEffects(forked.events).length);
  assert.equal(report.complete, true);
  assert.deepEqual(report.changes.map((c) => c.facet), ["system"]);

  const [change] = report.changes;
  assert.equal(change?.before, "You are terse.");
  assert.equal(change?.after, "You are terse. Answer in five words.");
  // One change, and every replayed model call it accounts for — a prompt
  // rewritten once should not be reported once per step below the fork point.
  assert.deepEqual(change?.keys, ["step:0", "step:1"]);
});

test("a fork that declares different tools names the tool that moved", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: answer(),
    // The module forgot `summarise` was there — the misconfiguration that used
    // to look exactly like a fork working correctly.
    tools: [lookup, summarise],
    atStep: 2,
    store,
    runId: "more-tools",
  });

  const report = explainStale("more-tools", store);
  const tools = only(report.changes, "tools");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.where, "summarise");
  assert.equal(tools[0]?.before, "(not declared)");
  assert.equal(tools[0]?.after, summarise.description);
  assert.equal(report.complete, true);
});

test("a tool whose description was reworded is reported on the description", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: answer(),
    tools: [{ ...lookup, description: "Look a term up. Call this a lot." }],
    atStep: 2,
    store,
    runId: "reworded",
  });

  const [change] = only(explainStale("reworded", store).changes, "tools");
  assert.equal(change?.where, "lookup · description");
  assert.equal(change?.before, lookup.description);
  assert.equal(change?.after, "Look a term up. Call this a lot.");
});

test("the same tools in another order say so, rather than naming no change", async () => {
  const store = new MemoryStore();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup, summarise],
    store,
    runId: "two-tools",
  });

  await fork("two-tools", {
    provider: answer(),
    tools: [summarise, lookup],
    atStep: 2,
    store,
    runId: "reordered",
  });

  const report = explainStale("reordered", store);
  const [change] = only(report.changes, "tools");
  assert.equal(change?.where, "order");
  assert.equal(change?.before, "lookup, summarise");
  assert.equal(change?.after, "summarise, lookup");
  assert.equal(report.complete, true);
});

test("a changed model and changed settings are named field by field", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    agent: { model: "claude-sonnet-5", maxTokens: 4000, effort: "low" },
    store,
    runId: "retuned",
  });

  const report = explainStale("retuned", store);
  assert.deepEqual(
    report.changes.map((c) => [c.facet, c.where ?? null, c.before, c.after]),
    [
      ["model", null, "claude-opus-5", "claude-sonnet-5"],
      ["settings", "maxTokens", "16000", "4000"],
      ["settings", "effort", "high", "low"],
    ],
  );
  assert.equal(report.complete, true);
});

test("an overridden tool result comes back as the message that moved under it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "nothing found" },
    store,
    runId: "counterfactual",
  });

  const report = explainStale("counterfactual", store);
  const [change] = only(report.changes, "conversation");
  // The tool result the substitution replaced, in the message the model was
  // shown — which is the thing the `conversation` facet was pointing at.
  assert.match(change?.where ?? "", /^message 2 · user · tool_result$/);
  assert.equal(change?.before, "definition of alpha");
  assert.equal(change?.after, "nothing found");
  assert.deepEqual(change?.keys, ["step:1"]);
  assert.equal(report.complete, true);
});

test("a replaced model response says what the replayed tool call was asked instead", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  // Step 0's turn asked for `lookup({term: "alpha"})`; hand it one that asks
  // the same tool a different question. The recorded answer still lands in
  // step:0#0:lookup, and is now an answer to nothing this run asked.
  await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    overrides: {
      "step:0": {
        model: "claude-opus-5",
        content: [toolUse("t1", "lookup", { term: "omega" })],
        stopReason: "tool_use",
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
    store,
    runId: "reasked",
  });

  const report = explainStale("reasked", store);
  const [change] = only(report.changes, "input");
  assert.deepEqual(change?.keys, ["step:0#0:lookup"]);
  assert.equal(change?.before, '{"term":"alpha"}');
  assert.equal(change?.after, '{"term":"omega"}');
});

test("a replay that reproduces its run has nothing stale to explain", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await replay("baseline", { provider: answer(), tools: [lookup], store, runId: "again" });

  const report = explainStale("again", store);
  assert.equal(report.staleEffects, 0);
  assert.deepEqual(report.changes, []);
  assert.equal(report.complete, true);
});

test("without the parent in the store the marking stands and says what is missing", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    agent: { system: "Answer in five words." },
    store,
    runId: "orphan",
  });

  // The fork's own log, read where its parent has never been — a run mailed
  // with a bug report, and the case `retrace export` exists for.
  const report = explainStaleEvents("orphan", forked.events);
  assert.equal(report.complete, false);
  assert.deepEqual(report.changes, []);
  assert.equal(report.unexplained.length, 1);
  assert.equal(report.unexplained[0]?.facet, "system");
  assert.match(report.unexplained[0]?.why ?? "", /baseline is not in this store/);
  assert.match(report.unexplained[0]?.why ?? "", /retrace import/);
});

test("a parent recorded before the log carried tools is named rather than guessed at", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  // Exactly what an older log looks like: everything else, and no declaration
  // of what the model was shown.
  for (const event of store.read("baseline")) {
    if (event.type === "run.started") delete event.tools;
  }

  await fork("baseline", {
    provider: answer(),
    tools: [lookup, summarise],
    atStep: 2,
    store,
    runId: "against-old",
  });

  const report = explainStale("against-old", store);
  assert.equal(report.complete, false);
  assert.equal(report.unexplained[0]?.facet, "tools");
  assert.match(report.unexplained[0]?.why ?? "", /baseline does not record the tools/);
});

test("an effect marked stale with no facets is reported as the log that named none", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  const forked = await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    agent: { system: "Answer in five words." },
    store,
    runId: "unnamed",
  });

  // A log written before the per-component digests: stale, and silent about
  // which component.
  const events: RetraceEvent[] = forked.events.map((e) =>
    e.type === "effect" && e.staleFacets ? { ...e, staleFacets: [] } : e,
  );

  const report = explainStaleEvents("unnamed", events, store.read("baseline"));
  assert.equal(report.complete, false);
  assert.equal(report.unexplained[0]?.facet, "the request");
  assert.match(report.unexplained[0]?.why ?? "", /before the per-component digests/);
});

test("every component the loop can record as moved is one this can explain", () => {
  // The guard on the whole file. Adding a facet to `requestFacets` without
  // teaching `explainFacet` about it would leave a run reporting a component
  // that moved and no account of it, which is the state this command exists to
  // end.
  assert.deepEqual([...EXPLAINED_FACETS].sort(), [...REQUEST_FACETS, ...TOOL_FACETS].sort());
});

test("the CLI prints both sides of what moved and exits zero", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: answer(),
    tools: [lookup],
    atStep: 2,
    agent: { system: "You are terse. Answer in five words." },
    store,
    runId: "forked",
  });

  // The CLI reads its own store off disk, so this exercises the command
  // through the same path a user takes, with the events handed to it.
  const io = capture();
  const code = await cli(["stale", "forked"], io, store);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /forked from baseline at step 2/);
  assert.match(io.text(), /system\n {2}step:0, step:1\n/);
  assert.match(io.text(), /- You are terse\.\n/);
  assert.match(io.text(), /\+ You are terse\. Answer in five words\.\n/);
  assert.match(io.text(), /explained: 2 stale effects, and 1 change is the whole of what moved/);
});

test("the CLI says so plainly when a run replayed nothing stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await replay("baseline", { provider: answer(), tools: [lookup], store, runId: "again" });

  const io = capture();
  const code = await cli(["stale", "again"], io, store);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /nothing stale/);
});

test("stale without a run id says so instead of guessing", async () => {
  const io = capture();
  assert.equal(await main(["stale"], io), 1);
  assert.match(io.errors(), /stale needs a run id/);
});

/**
 * The CLI opens its own store from `--dir`, so a test holding a `MemoryStore`
 * has to put the runs somewhere it can read. Written out as a real store
 * directory, which is also the only way to exercise the command end to end.
 */
async function cli(argv: string[], io: Io, store: MemoryStore): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "retrace-stale-"));
  try {
    const disk = new RunStore(dir);
    for (const runId of store.list()) {
      for (const event of store.read(runId)) disk.append(runId, event);
    }
    return await main([...argv, "--dir", dir], io);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
