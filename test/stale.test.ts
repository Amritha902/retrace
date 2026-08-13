import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  orderFacets,
  replay,
  REQUEST_FACETS,
  requestFacets,
  requestFingerprint,
  run,
  staleEffects,
  staleFacets,
  text,
  tool,
  TOOL_FACETS,
  toolFacets,
  toolFingerprint,
  toolUse,
  type Message,
  type ModelRequest,
  type RequestFacet,
  type RetraceEvent,
  type ToolUse,
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

/** Two model turns: one tool call, then an answer. */
const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [text("alpha, explained")] },
];

async function recordBaseline(store: MemoryStore) {
  return run("explain alpha", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId: "baseline",
  });
}

/** Which model effects came back replayed, and whether each was stale. */
function replayedModels(events: readonly RetraceEvent[]) {
  return effectsOf(events)
    .filter((e) => e.kind === "model" && e.replayed)
    .map((e) => ({ key: e.key, stale: e.stale === true }));
}

test("a recorded model call carries the digest of the request it answered", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const models = effectsOf(baseline.events).filter((e) => e.kind === "model");
  assert.equal(models.length, 2);
  for (const model of models) {
    assert.match(model.requestHash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(model.stale, undefined, "nothing was replayed, so nothing can be stale");
  }
  assert.notEqual(
    models[0]?.requestHash,
    models[1]?.requestHash,
    "step 1 asks with a longer conversation than step 0",
  );
});

test("a tool call carries the digest of the input it was made with", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const tools = effectsOf(baseline.events).filter((e) => e.kind === "tool");
  assert.equal(tools.length, 1);
  assert.match(tools[0]?.requestHash ?? "", /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(tools[0]?.requestFacets ?? {}), ["input"]);
  assert.equal(tools[0]?.stale, undefined, "nothing was replayed, so nothing can be stale");
});

test("a faithful replay marks nothing stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [lookup],
    store,
    runId: "replayed",
  });

  assert.deepEqual(replayedModels(replayed.events), [
    { key: "step:0", stale: false },
    { key: "step:1", stale: false },
  ]);
  assert.deepEqual(staleEffects(replayed.events), []);
});

test("replaying without the recorded tools marks the model calls stale", async () => {
  // The log still reproduces — that is what `replay` has always promised — but
  // the requests this loop builds declare no tools, so the answers it is being
  // handed were given to a different question. Worth saying out loud.
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [],
    store,
    runId: "toolless",
  });

  assert.equal(replayed.output, baseline.output, "the replay still reproduces");
  assert.deepEqual(replayedModels(replayed.events), [
    { key: "step:0", stale: true },
    { key: "step:1", stale: true },
  ]);
});

test("a fork that changes nothing replays a prefix with nothing stale in it", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("alpha, explained")] }]),
    atStep: 1,
    tools: [lookup],
    store,
    runId: "same",
  });

  assert.deepEqual(replayedModels(forked.events), [{ key: "step:0", stale: false }]);
});

test("a fork that rewrites the prompt marks the prefix it replays as stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("alpha.")] }]),
    atStep: 1,
    tools: [lookup],
    agent: { system: "Answer in one word." },
    store,
    runId: "reworded",
  });

  assert.equal(forked.output, "alpha.");
  // Step 0 replays an answer given to the old system prompt; step 1 is the
  // live step that actually heard the new one.
  assert.deepEqual(replayedModels(forked.events), [{ key: "step:0", stale: true }]);
  assert.deepEqual(
    staleEffects(forked.events).map((e) => e.key),
    ["step:0"],
  );
  const live = effectsOf(forked.events).filter((e) => !e.replayed);
  assert.deepEqual(live.map((e) => e.stale), [undefined]);
});

test("a log recorded without digests replays without claiming anything is stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  // What a log written before this existed looks like: results, no digests.
  for (const event of store.read("baseline")) {
    store.append(
      "older",
      event.type === "effect" ? { ...event, requestHash: undefined } : event,
    );
  }

  const replayed = await replay("older", {
    provider: new MockProvider([]),
    tools: [],
    store,
    runId: "from-older",
  });

  assert.equal(replayed.status, "completed");
  assert.deepEqual(replayedModels(replayed.events), [
    { key: "step:0", stale: false },
    { key: "step:1", stale: false },
  ]);
});

// ------------------------------------------------------------- the digest

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

const request: ModelRequest = {
  model: "claude-opus-5",
  system: "You are terse.",
  messages,
  tools: [{ name: "lookup", description: "look up", inputSchema: { type: "object" } }],
  maxTokens: 1000,
  effort: "high",
  thinking: "adaptive",
};

test("the request digest does not depend on the order the request was built in", () => {
  const reordered: ModelRequest = {
    thinking: "adaptive",
    effort: "high",
    maxTokens: 1000,
    tools: [{ inputSchema: { type: "object" }, description: "look up", name: "lookup" }],
    messages,
    system: "You are terse.",
    model: "claude-opus-5",
  };

  assert.equal(requestFingerprint(reordered), requestFingerprint(request));
});

test("the request digest ignores the provider's verbatim blocks", () => {
  // `raw` is the provider's own rendering of content the digest already covers.
  // Hashing it would make a log look changed because an SDK reshaped a field.
  const withRaw: ModelRequest = {
    ...request,
    messages: [
      ...messages,
      { role: "assistant", content: [{ type: "text", text: "hi" }], raw: { anything: true } },
    ],
  };
  const withoutRaw: ModelRequest = {
    ...request,
    messages: [...messages, { role: "assistant", content: [{ type: "text", text: "hi" }] }],
  };

  assert.equal(requestFingerprint(withRaw), requestFingerprint(withoutRaw));
});

/** Each way a request can change, and the one facet that should name it. */
const variants: Record<string, { request: ModelRequest; facet: RequestFacet }> = {
  model: { request: { ...request, model: "claude-sonnet-5" }, facet: "model" },
  system: { request: { ...request, system: "You are verbose." }, facet: "system" },
  "system removed": { request: { ...request, system: undefined }, facet: "system" },
  messages: {
    request: { ...request, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    facet: "conversation",
  },
  tools: { request: { ...request, tools: [] }, facet: "tools" },
  "tool description": {
    request: {
      ...request,
      tools: [{ name: "lookup", description: "look it up", inputSchema: { type: "object" } }],
    },
    facet: "tools",
  },
  maxTokens: { request: { ...request, maxTokens: 999 }, facet: "settings" },
  effort: { request: { ...request, effort: "low" }, facet: "settings" },
  thinking: { request: { ...request, thinking: "disabled" }, facet: "settings" },
};

test("every field that could change the answer changes the digest", () => {
  const base = requestFingerprint(request);
  for (const [what, { request: variant }] of Object.entries(variants)) {
    assert.notEqual(requestFingerprint(variant), base, `changing ${what} must change the digest`);
  }
});

test("every field that changes the digest is named by exactly one facet", () => {
  // The invariant the whole feature rests on. A field the digest covers and the
  // facets do not would show up as a stale step with no explanation — the log
  // saying "something moved" and being unable to say what.
  const base = requestFacets(request);
  for (const [what, { request: variant, facet }] of Object.entries(variants)) {
    const moved = REQUEST_FACETS.filter((f) => requestFacets(variant)[f] !== base[f]);
    assert.deepEqual(moved, [facet], `changing ${what} must move ${facet} and nothing else`);
  }
});

test("facets are named in a fixed order, whatever order they are found in", () => {
  assert.deepEqual(orderFacets(["settings", "system", "model"]), ["model", "system", "settings"]);
  assert.deepEqual(orderFacets(["tools", "tools"]), ["tools"], "a name is reported once");
  // A tool's facet is known, and sorts after the request's rather than with
  // whatever the build has never heard of.
  assert.deepEqual(orderFacets(["input", "temperature", "system"]), [
    "system",
    "input",
    "temperature",
  ]);
});

// ------------------------------------------------- what a tool was asked

const call: ToolUse = { type: "tool_use", id: "t1", name: "lookup", input: { term: "alpha" } };

test("the tool digest covers the input and not the order it was written in", () => {
  const reordered: ToolUse = {
    type: "tool_use",
    id: "t1",
    name: "lookup",
    input: { depth: 2, term: "alpha" },
  };
  assert.equal(
    toolFingerprint({ ...call, input: { term: "alpha", depth: 2 } }),
    toolFingerprint(reordered),
  );
  assert.notEqual(toolFingerprint({ ...call, input: { term: "beta" } }), toolFingerprint(call));
  assert.deepEqual(toolFacets(call), { input: toolFingerprint(call) });
  assert.deepEqual([...TOOL_FACETS], ["input"]);
});

test("the tool digest ignores the id the model gave the call", () => {
  // The id correlates a call with its result inside one turn. It is generated
  // fresh by the model and carries nothing about what the tool was asked, so
  // hashing it would make every call look changed.
  assert.equal(toolFingerprint({ ...call, id: "t99" }), toolFingerprint(call));
});

test("the tool digest ignores the tool's name, which the effect's key already fixes", () => {
  // Not an oversight: a call to a different tool lands in a different slot, so
  // it is a divergence — a louder thing than staleness — long before a digest
  // would be consulted. `a fork whose shape changed is a divergence` in
  // test/fork.test.ts is where that is held.
  assert.equal(toolFingerprint({ ...call, name: "search" }), toolFingerprint(call));
});

// ------------------------------------------------------- what went stale

test("a fork that rewrites the prompt says the prompt is what moved", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("alpha.")] }]),
    atStep: 1,
    tools: [lookup],
    agent: { system: "Answer in one word." },
    store,
    runId: "reworded",
  });

  assert.deepEqual(staleFacets(forked.events), ["system"]);
  assert.deepEqual(staleEffects(forked.events)[0]?.staleFacets, ["system"]);
});

test("replaying without the recorded tools says the tools are what moved", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const replayed = await replay("baseline", {
    provider: new MockProvider([]),
    tools: [],
    store,
    runId: "toolless",
  });

  // Not the prompt and not the conversation: this loop rebuilt the same run
  // with nothing declared, which is exactly what the missing --module looks like.
  assert.deepEqual(staleFacets(replayed.events), ["tools"]);
});

test("an overridden value makes the steps below it stale on the conversation", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const counterfactual = await fork("baseline", {
    provider: new MockProvider([{ content: [text("nothing to explain")] }]),
    atStep: 2,
    tools: [lookup],
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  // Step 1 replays an answer given to a conversation that no longer exists —
  // the tool result above it changed. The prompt did not, and saying so is the
  // difference between "you rewrote the agent" and "you rewrote the world".
  assert.deepEqual(staleFacets(counterfactual.events), ["conversation"]);
  assert.deepEqual(
    staleEffects(counterfactual.events).map((e) => e.key),
    ["step:1"],
  );
});

test("several changes at once are all named, in a fixed order", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);

  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("alpha.")] }]),
    atStep: 1,
    tools: [],
    agent: { system: "Answer in one word.", model: "claude-sonnet-5" },
    store,
    runId: "three-changes",
  });

  assert.deepEqual(staleFacets(forked.events), ["model", "system", "tools"]);
});

// --------------------------------- a tool handed the answer to another call

/** Two lookups, then an answer: the second step's call is built from the first. */
const twoLookups = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("both, explained")] },
];

/** A model response that asks for a lookup of `term`, shaped as the log holds it. */
function askingFor(term: string) {
  return {
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: "t1", name: "lookup", input: { term } }],
    stopReason: "tool_use",
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

test("a replayed tool call given the answer to a different call comes back stale", async () => {
  const store = new MemoryStore();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(twoLookups()),
    tools: [lookup],
    store,
    runId: "two",
  });

  // Replacing the model response at step 0 changes what step 0's tool is asked.
  // The slot is the same, so the log answers it — with the answer to "alpha".
  // Before the tool digest that was silent, and a counterfactual you would have
  // read as the tool's answer to a question it was never put.
  const forked = await fork("two", {
    provider: new MockProvider([{ content: [text("live answer")] }]),
    atStep: 2,
    tools: [lookup],
    overrides: { "step:0": askingFor("OMEGA") },
    store,
    runId: "rerouted",
  });

  const stale = staleEffects(forked.events);
  assert.deepEqual(
    stale.map((e) => ({ key: e.key, facets: e.staleFacets })),
    [
      // The tool was asked for OMEGA and handed the definition of alpha.
      { key: "step:0#0:lookup", facets: ["input"] },
      // And step 1 answered a conversation containing that wrong answer.
      { key: "step:1", facets: ["conversation"] },
    ],
  );
  assert.deepEqual(staleFacets(forked.events), ["conversation", "input"]);
});

test("a tool call whose input did not move stays clean under a changed conversation", async () => {
  const store = new MemoryStore();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(twoLookups()),
    tools: [lookup],
    store,
    runId: "two",
  });

  // The ordinary counterfactual: a tool *result* is replaced. Every model call
  // above it is answering a conversation that no longer exists — but the calls
  // themselves are unchanged, because the responses they came from replayed
  // intact. A digest that marked those stale too would be crying wolf on the
  // one shape of fork this thing exists to make cheap.
  const forked = await fork("two", {
    provider: new MockProvider([{ content: [text("live answer")] }]),
    atStep: 2,
    tools: [lookup],
    overrides: { "step:0#0:lookup": "no results" },
    store,
    runId: "counterfactual",
  });

  assert.deepEqual(
    staleEffects(forked.events).map((e) => e.key),
    ["step:1"],
  );
  assert.deepEqual(staleFacets(forked.events), ["conversation"]);
});

test("a plain replay proves the tool inputs were rebuilt, not merely the results reused", async () => {
  const store = new MemoryStore();
  await run("explain alpha and beta", {
    agent,
    provider: new MockProvider(twoLookups()),
    tools: [lookup],
    store,
    runId: "two",
  });

  const replayed = await replay("two", {
    provider: new MockProvider([]),
    tools: [lookup],
    store,
    runId: "again",
  });

  const tools = effectsOf(replayed.events).filter((e) => e.kind === "tool");
  assert.equal(tools.length, 2);
  for (const call of tools) {
    assert.equal(call.replayed, true);
    assert.equal(call.stale, undefined, "the loop asked each tool exactly what it asked before");
  }
});

test("a log whose tool calls carry no digest replays without claiming they are stale", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  // What a log written before tool calls were stamped looks like: the model
  // calls have digests, the tool calls do not.
  for (const event of store.read("baseline")) {
    store.append(
      "older",
      event.type === "effect" && event.kind === "tool"
        ? { ...event, requestHash: undefined, requestFacets: undefined }
        : event,
    );
  }

  const replayed = await replay("older", {
    provider: new MockProvider([]),
    tools: [lookup],
    store,
    runId: "from-older",
  });

  assert.equal(replayed.status, "completed");
  assert.deepEqual(staleEffects(replayed.events), []);
});

test("a parent recorded without facets leaves a stale step unexplained rather than misexplained", async () => {
  const store = new MemoryStore();
  await recordBaseline(store);
  // A log from a build that stamped requests but did not break them up.
  for (const event of store.read("baseline")) {
    store.append(
      "older",
      event.type === "effect" ? { ...event, requestFacets: undefined } : event,
    );
  }

  const replayed = await replay("older", {
    provider: new MockProvider([]),
    tools: [],
    store,
    runId: "from-older",
  });

  assert.deepEqual(replayedModels(replayed.events), [
    { key: "step:0", stale: true },
    { key: "step:1", stale: true },
  ], "the digest still compares, so staleness is still detected");
  assert.deepEqual(staleFacets(replayed.events), [], "but nothing was compared facet by facet");
  for (const effect of staleEffects(replayed.events)) {
    assert.equal(effect.staleFacets, undefined, "and the log does not invent an explanation");
  }
});
