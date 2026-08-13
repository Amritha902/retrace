import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  requestFingerprint,
  run,
  staleEffects,
  text,
  tool,
  toolUse,
  type Message,
  type ModelRequest,
  type RetraceEvent,
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

test("a tool call carries no request digest", async () => {
  const store = new MemoryStore();
  const baseline = await recordBaseline(store);

  const tools = effectsOf(baseline.events).filter((e) => e.kind === "tool");
  assert.equal(tools.length, 1);
  // A tool's input below a fork point comes out of the log with everything
  // else, so there is nothing it could drift against.
  assert.equal(tools[0]?.requestHash, undefined);
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

test("every field that could change the answer changes the digest", () => {
  const base = requestFingerprint(request);
  const variants: Record<string, ModelRequest> = {
    model: { ...request, model: "claude-sonnet-5" },
    system: { ...request, system: "You are verbose." },
    "system removed": { ...request, system: undefined },
    messages: { ...request, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    tools: { ...request, tools: [] },
    "tool description": {
      ...request,
      tools: [{ name: "lookup", description: "look it up", inputSchema: { type: "object" } }],
    },
    maxTokens: { ...request, maxTokens: 999 },
    effort: { ...request, effort: "low" },
    thinking: { ...request, thinking: "disabled" },
  };

  for (const [what, variant] of Object.entries(variants)) {
    assert.notEqual(requestFingerprint(variant), base, `changing ${what} must change the digest`);
  }
});
