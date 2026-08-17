import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  fork,
  formatUsd,
  MemoryStore,
  MockProvider,
  objectSchema,
  planFork,
  plannedStaleFacets,
  run,
  RunStore,
  staleEffects,
  staleFacets,
  text,
  tool,
  toolUse,
  type Tool,
} from "../src/index.ts";
import { calls } from "./fixtures/agent-module.ts";
import { sent } from "./fixtures/irreversible-module.ts";

const MODULE = fileURLToPath(new URL("./fixtures/agent-module.ts", import.meta.url));
const IRREVERSIBLE = fileURLToPath(new URL("./fixtures/irreversible-module.ts", import.meta.url));

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 6,
});

/** The tool the recorded run declares, with a counter, because a plan must not call it. */
function lookupTool(): { tool: Tool; calls: () => number } {
  let ran = 0;
  return {
    calls: () => ran,
    tool: tool({
      name: "lookup",
      description: "Look a term up. Call this when you need a fact you don't have.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => {
        ran++;
        return `definition of ${input.term}`;
      },
    }),
  };
}

/** Two tool calls, then an answer: three steps, five effects. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

async function record(store: MemoryStore): Promise<Tool> {
  const lookup = lookupTool();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup.tool],
    store,
    runId: "baseline",
  });
  return lookup.tool;
}

test("a plan cuts the log where the fork would, and prices the prefix", async () => {
  const store = new MemoryStore();
  const lookup = await record(store);

  const plan = planFork("baseline", { atStep: 2, tools: [lookup], store });

  assert.equal(plan.recorded, 5);
  assert.equal(plan.replayed, 4, "steps 0 and 1: two model calls and two tool calls");
  assert.equal(plan.replayedSteps, 2);
  assert.equal(plan.atStep, 2);
  assert.equal(plan.atEffect, undefined);
  assert.ok(plan.savedUsd > 0);
  assert.ok(plan.savedUsd < plan.costUsd, "step 2 is not in the prefix, so it is not saved");
});

test("a fork that changes nothing is planned as changing nothing", async () => {
  const store = new MemoryStore();
  const lookup = await record(store);

  const plan = planFork("baseline", { atStep: 2, tools: [lookup], store });

  assert.deepEqual(plan.stale, []);
  assert.equal(plan.blocked, undefined);
  assert.equal(plan.undigested, 0);
  assert.deepEqual(plan.undeclared, []);
});

test("what the plan predicts is what the fork goes on to report", async () => {
  const store = new MemoryStore();
  const lookup = await record(store);
  const rewritten = { system: "Answer in at most ten words." };

  const plan = planFork("baseline", { atStep: 2, tools: [lookup], agent: rewritten, store });
  assert.deepEqual(plan.stale.map((s) => s.key), ["step:0", "step:1"]);
  assert.deepEqual(plannedStaleFacets(plan), ["system"]);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("terse enough")] }]),
    tools: [lookup],
    atStep: 2,
    agent: rewritten,
    store,
    runId: "forked",
  });

  // The whole point: the prediction and the run agree, effect for effect and
  // facet for facet, and one of them cost nothing to get.
  assert.deepEqual(
    staleEffects(forked.events).map((e) => e.key),
    plan.stale.map((s) => s.key),
  );
  assert.deepEqual(staleFacets(forked.events), plannedStaleFacets(plan));
  assert.equal(formatUsd(forked.totals.savedUsd), formatUsd(plan.savedUsd));
  assert.equal(forked.totals.steps - 2, 1, "the fork ran one step live, as planned");
});

test("a module that forgot the run's tools is one plan away, not one live step away", async () => {
  const store = new MemoryStore();
  await record(store);

  const plan = planFork("baseline", { atStep: 2, tools: [], store });

  assert.deepEqual(plannedStaleFacets(plan), ["tools"]);
  assert.deepEqual(plan.undeclared, ["lookup"], "the log says the run declared it; this does not");

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("answered with no tools at all")] }]),
    tools: [],
    atStep: 2,
    store,
    runId: "toolless",
  });
  assert.deepEqual(staleFacets(forked.events), plannedStaleFacets(plan));
});

test("without the tools a fork would declare, the plan says so rather than guessing", async () => {
  const store = new MemoryStore();
  await record(store);

  const plan = planFork("baseline", { atStep: 2, store });

  assert.deepEqual(plan.stale, [], "no request was rebuilt, so nothing was found stale");
  assert.match(plan.blocked ?? "", /no tools were given/);
  assert.deepEqual(plan.undeclared, [], "there is nothing to hold the declarations against");
  assert.equal(plan.replayed, 4, "the arithmetic of the free prefix needs no module");
});

test("a substituted value is planned as moving the conversation under the steps above it", async () => {
  const store = new MemoryStore();
  const lookup = await record(store);
  const overrides = { "step:0#0:lookup": "no results" };

  const plan = planFork("baseline", { atStep: 2, tools: [lookup], overrides, store });

  assert.deepEqual(plan.stale.map((s) => s.key), ["step:1"]);
  assert.deepEqual(plannedStaleFacets(plan), ["conversation"], "the agent is the recorded one");

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("nothing found")] }]),
    tools: [lookup],
    atStep: 2,
    overrides,
    store,
    runId: "counterfactual",
  });
  assert.deepEqual(
    staleEffects(forked.events).map((e) => e.key),
    plan.stale.map((s) => s.key),
  );
  assert.deepEqual(staleFacets(forked.events), plannedStaleFacets(plan));
});

test("planning a fork of a fork prices the prefix its parent got free", async () => {
  const store = new MemoryStore();
  const lookup = await record(store);
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("first answer")] }]),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  // The fork's own prefix cost list price and was billed nothing. A fork of it
  // saves that cost again, which is the claim the whole lineage rests on.
  const plan = planFork("forked", { atStep: 2, tools: [lookup], store });
  const again = await fork("forked", {
    provider: new MockProvider([{ content: [text("second answer")] }]),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "twice",
  });

  assert.ok(forked.totals.billedUsd > 0, "the fork paid for the step it ran live");
  assert.equal(formatUsd(plan.savedUsd), formatUsd(again.totals.savedUsd));
  assert.equal(plan.replayed, 4);
});

test("a plan reaches neither the provider nor the tools", async () => {
  const store = new MemoryStore();
  const lookup = lookupTool();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup.tool],
    store,
    runId: "baseline",
  });
  const before = lookup.calls();

  planFork("baseline", { atStep: 1, tools: [lookup.tool], agent: { system: "different" }, store });

  assert.equal(lookup.calls(), before, "planning is reading, and there is no provider to pass it");
});

/* A run whose second step mails the answer, so a mid-step fork has a live tail. */

function courier(): { tools: Tool[]; sends: () => number } {
  let sends = 0;
  return {
    sends: () => sends,
    tools: [
      lookupTool().tool,
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

/** Step 1 looks something up and mails it, so its tail holds two calls. */
const mailing = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  {
    content: [
      toolUse("t2", "lookup", { term: "beta" }),
      toolUse("t3", "send_email", { to: "reader@example.com" }),
    ],
  },
  { content: [text("looked up and sent")] },
];

async function recordMailing(store: MemoryStore): Promise<Tool[]> {
  const t = courier();
  await run("look alpha up and mail it", {
    agent,
    provider: new MockProvider(mailing()),
    tools: t.tools,
    store,
    runId: "baseline",
  });
  return t.tools;
}

test("a mid-step plan names the calls the fork would make for real", async () => {
  const store = new MemoryStore();
  const tools = await recordMailing(store);

  const plan = planFork("baseline", { atEffect: "step:1#0:lookup", tools, store });

  assert.equal(plan.atStep, 1, "the fork goes live inside step 1");
  assert.equal(plan.atEffect, "step:1#0:lookup");
  assert.deepEqual(
    plan.live.map((c) => c.key),
    ["step:1#0:lookup", "step:1#1:send_email"],
    "the model turn that asked is replayed, so the whole tail it asked for is knowable",
  );
});

test("a plan holds back the same call the fork would refuse to repeat", async () => {
  const store = new MemoryStore();
  await recordMailing(store);
  const t = courier();

  const plan = planFork("baseline", { atEffect: "step:1#0:lookup", tools: t.tools, store });
  assert.deepEqual(plan.held.map((c) => c.key), ["step:1#1:send_email"]);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("never reached")] }]),
    tools: t.tools,
    atEffect: "step:1#0:lookup",
    store,
    runId: "forked",
  });

  assert.equal(forked.status, "failed");
  assert.equal(t.sends(), 0, "the plan was right: the mail was not sent");
  assert.match(forked.error ?? "", new RegExp(plan.held[0]!.key));
});

test("--allow-irreversible turns a held call into one the fork would make", async () => {
  const store = new MemoryStore();
  const tools = await recordMailing(store);

  const plan = planFork("baseline", {
    atEffect: "step:1#0:lookup",
    tools,
    allowIrreversible: true,
    store,
  });

  assert.deepEqual(plan.held, []);
  assert.deepEqual(plan.live.map((c) => c.irreversible), [false, true], "still named, not refused");
});

test("a fork at a step has no live tail to name, because the model has not been asked", async () => {
  const store = new MemoryStore();
  const tools = await recordMailing(store);

  const plan = planFork("baseline", { atStep: 1, tools, store });

  assert.deepEqual(plan.live, []);
  assert.deepEqual(plan.held, [], "what step 1 will ask for is the reason you forked there");
});

/* The command. */

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string } {
  let out = "";
  return {
    out: (s) => (out += s),
    err: (s) => (out += s),
    text: () => out.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

async function recordOnDisk(t: TestContext, dir: string): Promise<void> {
  calls.length = 0;
  t.after(() => void (calls.length = 0));
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookupTool().tool],
    store: new RunStore(dir),
    runId: "baseline",
  });
}

test("the CLI plans a fork without running any of it", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(["plan", "baseline", "--at", "2", "--dir", dir, "--module", MODULE], io);

  assert.equal(code, 0);
  assert.deepEqual(calls, [], "the fixture records every call it serves, and served none");
  assert.match(io.text(), /replays\s+4 of 5 effects, 2 steps whole/);
  // The fixture rewrites the system prompt, which is the staleness a fork means.
  assert.match(io.text(), /stale\s+2 replayed model calls/);
  assert.match(io.text(), /— system/);
  assert.match(io.text(), /nothing ran/);
});

test("the CLI plan says what it cannot know without a module", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  const code = await main(["plan", "baseline", "--at", "2", "--dir", dir], io);

  assert.equal(code, 0);
  assert.match(io.text(), /replays\s+4 of 5 effects/, "the free prefix needs no module");
  assert.match(io.text(), /no tools were given/);
});

test("the CLI plan exits non-zero on a fork that would refuse to run", async (t) => {
  const dir = tempDir(t);
  sent.length = 0;
  t.after(() => void (sent.length = 0));
  const t2 = courier();
  await run("look alpha up and mail it", {
    agent,
    provider: new MockProvider(mailing()),
    tools: t2.tools,
    store: new RunStore(dir),
    runId: "baseline",
  });
  const io = capture();

  const code = await main(
    ["plan", "baseline", "--at", "step:1#1:send_email", "--dir", dir, "--module", IRREVERSIBLE],
    io,
  );

  assert.equal(code, 1);
  assert.deepEqual(sent, [], "planning a refused fork sends no mail either");
  assert.match(io.text(), /"send_email" at step:1#1:send_email is marked irreversible/);
  assert.match(io.text(), /--allow-irreversible/);
});

test("plan without a fork point says which one it needs", async (t) => {
  const dir = tempDir(t);
  await recordOnDisk(t, dir);
  const io = capture();

  assert.equal(await main(["plan", "baseline", "--dir", dir], io), 1);
  assert.match(io.text(), /plan needs --at/);
});
