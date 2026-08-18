import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  compareEvents,
  compareRuns,
  defineAgent,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  resume,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  verifyRun,
  type RetraceEvent,
} from "../src/index.ts";

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/** Three model turns: two tool calls, then an answer. Five effects, four below step 2. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

async function recordBaseline(store: MemoryStore | RunStore, runId = "baseline") {
  return run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId,
  });
}

/** A fork off `baseline` at step 2, answering in whatever words it was given. */
async function forkAt2(store: MemoryStore | RunStore, runId: string, answer: string) {
  return fork("baseline", {
    provider: new MockProvider([{ content: [text(answer)] }]),
    tools: [lookup],
    atStep: 2,
    store,
    runId,
  });
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

test("a run compared with itself holds every effect it has", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const cmp = compareRuns("baseline", "baseline", store);

  assert.equal(cmp.kinship.kind, "same");
  assert.equal(cmp.divergedAt, -1);
  assert.equal(cmp.pairs.length, 5);
  assert.equal(cmp.ok, true);
});

test("a fork and its parent are held to the prefix the fork replayed, and nothing above it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await forkAt2(store, "forked", "a shorter ending");

  const cmp = compareRuns("baseline", "forked", store);

  assert.deepEqual(cmp.kinship, {
    kind: "parent",
    parent: "a",
    origin: { runId: "baseline", atStep: 2 },
  });
  // Four effects came out of baseline's log, and the fifth is the fork's own
  // answer — which is the effect it forked in order to change.
  assert.equal(cmp.claimed, 4);
  assert.equal(cmp.divergedAt, 4);
  assert.equal(cmp.pairs[4]?.verdict, "value", "the same model call, answered differently");
  assert.equal(cmp.ok, true, "diverging above the fork point is what forking is");
});

test("two forks of the same run check each other, with the run they came from gone", async () => {
  const home = new MemoryStore();
  await recordBaseline(home);
  await forkAt2(home, "fork-a", "ten words");
  await forkAt2(home, "fork-b", "five words");

  // The case this exists for: the two forks travel and their parent does not.
  const away = new MemoryStore();
  for (const runId of ["fork-a", "fork-b"]) {
    for (const event of home.read(runId)) away.append(runId, event);
  }

  // verify is the check that gives up here — a fork whose parent is not in the
  // store is a claim of a free prefix with nothing to check it against.
  const alone = verifyRun("fork-a", away);
  assert.equal(alone.complete, false);
  for (const name of ["parent", "lineage"]) {
    const check = alone.checks.find((c) => c.name === name);
    assert.equal(check?.status, "skipped", check?.detail);
    assert.match(check.detail, /baseline/);
  }

  const cmp = compareRuns("fork-a", "fork-b", away);

  assert.deepEqual(cmp.kinship, { kind: "siblings", origin: "baseline" });
  assert.equal(cmp.claimed, 4, "both forks replayed baseline's first four effects");
  assert.equal(cmp.ok, true);
  assert.equal(cmp.divergedAt, 4);
});

test("a doctored free prefix is caught by the sibling that claims the same one", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await forkAt2(store, "fork-a", "ten words");
  await forkAt2(store, "fork-b", "five words");

  const doctored = tampered(
    store.read("fork-b"),
    (e) => e.type === "effect" && e.kind === "tool" && e.key === "step:0#0:lookup",
    (e) => {
      if (e.type === "effect") e.value = "definition of something else entirely";
    },
  );

  const cmp = compareEvents("fork-a", store.read("fork-a"), "fork-b", doctored);

  assert.equal(cmp.ok, false);
  assert.match(cmp.contradiction ?? "", /effect 1 \(tool:step:0#0:lookup\) differs/);
  assert.match(cmp.contradiction ?? "", /fork-a and fork-b both replayed it from baseline/);
});

test("a fork whose free prefix is not its parent's contradicts the parent", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await forkAt2(store, "forked", "a shorter ending");

  const doctored = tampered(
    store.read("forked"),
    (e) => e.type === "effect" && e.kind === "tool" && e.key === "step:1#0:lookup",
    (e) => {
      if (e.type === "effect") e.value = "a definition baseline never recorded";
    },
  );

  const cmp = compareEvents("baseline", store.read("baseline"), "forked", doctored);

  assert.equal(cmp.ok, false);
  assert.match(cmp.contradiction ?? "", /forked replayed it from baseline rather than running it/);
  assert.match(cmp.contradiction ?? "", /a free prefix that is not the prefix it came from/);
});

test("a fork that ran everything itself claims nothing of its parent", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("straight to an answer")] }]),
    tools: [lookup],
    atStep: 0,
    store,
    runId: "from-scratch",
  });

  const cmp = compareRuns("baseline", "from-scratch", store);

  assert.equal(cmp.kinship.kind, "parent");
  assert.equal(cmp.claimed, 0, "forking at 0 replays nothing, so nothing is owed");
  assert.equal(cmp.divergedAt, 0);
  assert.equal(cmp.ok, true);
});

test("two runs with no relation between them are compared and held to nothing", async () => {
  const store = new MemoryStore();
  await recordBaseline(store, "one");
  await run("explain gamma", {
    agent,
    provider: new MockProvider([{ content: [text("gamma, explained")] }]),
    tools: [lookup],
    store,
    runId: "two",
  });

  const cmp = compareRuns("one", "two", store);

  assert.deepEqual(cmp.kinship, { kind: "unrelated" });
  assert.equal(cmp.claimed, 0);
  assert.equal(cmp.divergedAt, 0);
  assert.equal(cmp.ok, true, "runs that owe each other nothing cannot contradict each other");
});

test("an override is the one place inside the prefix the two are meant to disagree", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("nothing found, so nothing to say")] }]),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "no such term" },
    store,
    runId: "counterfactual",
  });

  const cmp = compareRuns("baseline", "counterfactual", store);

  assert.equal(cmp.claimed, 4);
  assert.equal(cmp.excused, 1);
  assert.equal(cmp.ok, true, "a substituted value is a difference the fork asked for");
  assert.equal(cmp.pairs[1]?.verdict, "value");
  // The effects between the substitution and the fork point still came out of
  // the log unchanged, so the claim carries on past it rather than stopping.
  assert.equal(cmp.pairs[3]?.verdict, "same");
});

test("a resumed run owes its parent everything except the call it retried", async () => {
  const store = new MemoryStore();
  await recordBaseline(store, "full");

  // A killed run: the log stops after step 1's model call, so the tool call it
  // asked for never reached disk.
  let effects = 0;
  for (const event of store.read("full")) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && effects++ === 3) break;
    store.append("killed", event);
  }
  await resume("killed", {
    provider: new MockProvider([{ content: [text("alpha and beta, explained")] }]),
    tools: [lookup],
    store,
    runId: "resumed",
  });

  const cmp = compareRuns("killed", "resumed", store);

  assert.equal(cmp.kinship.kind, "parent");
  assert.equal(cmp.claimed, 3, "the three effects the killed log holds, and not the retried call");
  assert.equal(cmp.ok, true);
});

test("a throw is an outcome, so a run that succeeded where another failed differs there", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const died = tampered(
    store.read("baseline"),
    (e) => e.type === "effect" && e.kind === "model" && e.key === "step:1",
    (e) => {
      if (e.type === "effect") {
        e.value = null;
        e.failed = { name: "APIOverloadedError", message: "the model is overloaded" };
      }
    },
  );

  const cmp = compareEvents("baseline", store.read("baseline"), "died", died);

  assert.equal(cmp.pairs[2]?.verdict, "value", "the same call, one of them having thrown");
  assert.equal(cmp.divergedAt, 2);
});

test("the CLI collapses the shared prefix and names where the two went their own way", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await recordBaseline(store);
  await forkAt2(store, "forked", "a shorter ending");
  const io = capture();

  const code = await main(["diff", "baseline", "forked", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /0–3 = 4 shared/);
  assert.match(io.text(), /4 ≠ model:step:2 — same call, same question, different answer/);
  assert.match(io.text(), /free\s+4 effects forked replayed from baseline, value for value/);
  assert.match(io.text(), /diverges\s+at effect 4, the first effect either run ran for itself/);
  // This fork rewrote nothing about the request — only what came back — so the
  // honest reading of where it parted is that the question did not move.
  assert.match(io.text(), /asked\s+the same question there, answered differently/);
  assert.match(io.text(), /the provider answered one request two ways/);
  assert.match(io.text(), /ended\s+both completed, with different answers/);
});

test("the CLI exits non-zero on a prefix two runs cannot both have taken from one log", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await recordBaseline(store);
  await forkAt2(store, "fork-a", "ten words");
  await forkAt2(store, "fork-b", "five words");

  const doctored = tampered(
    store.read("fork-b"),
    (e) => e.type === "effect" && e.kind === "model" && e.key === "step:1",
    (e) => {
      if (e.type === "effect") e.value = { ...(e.value as object), stopReason: "end_turn" };
    },
  );
  writeFileSync(
    join(dir, "runs", "fork-b.jsonl"),
    `${doctored.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
  const io = capture();

  const code = await main(["diff", "fork-a", "fork-b", "--dir", dir], io);

  assert.equal(code, 1);
  assert.match(io.text(), /contradicted: effect 2 \(model:step:1\) differs/);
  assert.match(io.text(), /both replayed it from baseline/);
});

test("a fork that rewrote the prompt names the part of the question that moved", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("ten words")] }]),
    tools: [lookup],
    atStep: 2,
    agent: { system: "Answer in at most ten words." },
    store,
    runId: "shorter",
  });

  const cmp = compareRuns("baseline", "shorter", store);

  assert.equal(cmp.divergedAt, 4);
  assert.deepEqual(cmp.pairs[4]?.asked, { kind: "moved", facets: ["system"] });
});

test("a fork that changed only the answer parted on a question that did not move", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  await forkAt2(store, "forked", "a shorter ending");

  const cmp = compareRuns("baseline", "forked", store);

  // The requests at step 2 are the same request, digest for digest: this fork
  // swapped the provider and nothing the model was asked. What separates the
  // two runs is on the answering side, which is the one reading of a divergence
  // no single log can offer.
  assert.deepEqual(cmp.pairs[4]?.asked, { kind: "same" });
});

test("a tool answering one input two ways is told apart from a run that asked something else", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await recordBaseline(store, "before");
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [
      tool({
        ...lookup,
        run: (input: { term: string }) => `definition of ${input.term}, revised`,
      }),
    ],
    store,
    runId: "after",
  });

  const cmp = compareRuns("before", "after", store);

  assert.equal(cmp.kinship.kind, "unrelated");
  assert.equal(cmp.divergedAt, 1, "the model said the same thing; the corpus did not");
  assert.deepEqual(cmp.pairs[1]?.asked, { kind: "same" });

  const io = capture();
  const code = await main(["diff", "before", "after", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /1 ≠ tool:step:0#0:lookup — same call, same question, different answer/);
  assert.match(io.text(), /the tool answered one input two ways/);
});

test("a value a run was told to serve is not a question that moved", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await recordBaseline(store);
  await fork("baseline", {
    provider: new MockProvider([{ content: [text("nothing to go on")] }]),
    tools: [lookup],
    atStep: 2,
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  const cmp = compareRuns("baseline", "counterfactual", store);

  assert.equal(cmp.divergedAt, 1);
  assert.equal(cmp.excused, 1);
  assert.equal(cmp.pairs[1]?.asked, undefined, "a substituted value answers no question");
  // The substitution's reach is the part worth seeing: the live step above it
  // was asked something the parent never asked, and says which component.
  assert.deepEqual(cmp.pairs[4]?.asked, { kind: "moved", facets: ["conversation"] });

  const io = capture();
  const code = await main(["diff", "baseline", "counterfactual", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /1 ≠ tool:step:0#0:lookup — same call, a value one of them was told to serve/);
  assert.match(io.text(), /4 ≠ model:step:2 — same call, asked something else — conversation/);
  assert.doesNotMatch(io.text(), /^asked/m, "there is no question behind a value someone set");
});

test("a call recorded before digests existed leaves the question unsettled rather than guessed at", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await recordBaseline(store);
  await forkAt2(store, "forked", "a shorter ending");

  const bare = tampered(
    store.read("forked"),
    (e) => e.type === "effect" && e.kind === "model" && e.key === "step:2",
    (e) => {
      if (e.type !== "effect") return;
      delete e.requestHash;
      delete e.requestFacets;
    },
  );

  const cmp = compareEvents("baseline", store.read("baseline"), "forked", bare);

  assert.equal(cmp.pairs[4]?.asked?.kind, "unknown");
  assert.match(
    cmp.pairs[4]?.asked?.kind === "unknown" ? cmp.pairs[4].asked.why : "",
    /before a call carried a digest/,
  );

  writeFileSync(
    join(dir, "runs", "forked.jsonl"),
    `${bare.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
  const io = capture();

  const code = await main(["diff", "baseline", "forked", "--dir", dir], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /4 ≠ model:step:2 — same call, different result/);
  assert.match(io.text(), /asked\s+not something these two logs settle/);
});

test("a fetch answered two ways at one slot is the world moving, unless the body was never read", async (t) => {
  for (const [body, expected] of [
    [undefined, "same"],
    [new FormData(), "unknown"],
  ] as const) {
    const store = new MemoryStore();
    for (const [runId, answer] of [
      ["first", "three hits"],
      ["second", "five hits"],
    ]) {
      const stub = stubFetch(() => new Response(answer, { status: 200 }));
      t.after(stub.restore);
      await run("what does the corpus say", {
        agent,
        provider: new MockProvider([
          { content: [toolUse("t1", "ask", { term: "alpha" })] },
          { content: [text(`the corpus says ${answer}`)] },
        ]),
        tools: [asks(body)],
        store,
        runId,
      });
      stub.restore();
    }

    const cmp = compareRuns("first", "second", store);
    const fetched = cmp.pairs.find((p) => p.a?.kind === "fetch");

    assert.equal(fetched?.verdict, "value", "the corpus answered the two runs differently");
    assert.equal(fetched?.asked?.kind, expected);
  }
});

/** A tool that asks the corpus through `ctx.fetch`, optionally posting `body`. */
function asks(body: BodyInit | undefined) {
  return tool({
    name: "ask",
    description: "Ask the corpus about a term. Call this when the answer depends on a fact.",
    inputSchema: objectSchema({ term: { type: "string" } }),
    run: async (input: { term: string }, ctx) => {
      const res = await ctx.fetch(
        `https://corpus.test/?q=${input.term}`,
        body === undefined ? undefined : { method: "POST", body },
      );
      return res.text();
    },
  });
}

/** A `fetch` that never leaves the process. Every run here is offline, on purpose. */
function stubFetch(answer: () => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test("diff without two run ids says so instead of guessing", async (t) => {
  const io = capture();

  const code = await main(["diff", "baseline", "--dir", tempDir(t)], io);

  assert.equal(code, 1);
  assert.match(io.errors(), /diff needs two run ids/);
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-compare-"));
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
