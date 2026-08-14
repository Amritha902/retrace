import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  rebuildRequests,
  requestFingerprint,
  resume,
  run,
  StreamingMockProvider,
  text,
  tool,
  toolUse,
  verifyEvents,
  verifyRun,
  type AgentSpec,
  type Check,
  type ModelRequest,
  type ModelResponse,
  type RetraceEvent,
  type RunResult,
  type ScriptedTurn,
  type VerifyReport,
} from "../src/index.ts";

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/** Two tool calls, then an answer: five effects, three model requests to rebuild. */
const script = (): ScriptedTurn[] => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

const answer = (): ScriptedTurn[] => [{ content: [text("alpha and beta, explained")] }];

function record(store: MemoryStore, runId = "baseline"): Promise<RunResult> {
  return run("explain alpha and beta", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store,
    runId,
  });
}

function requests(events: readonly RetraceEvent[]): Check {
  const found = verifyEvents("under test", events).checks.find((c) => c.name === "requests");
  assert.ok(found, "verify has no check called \"requests\"");
  return found;
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

const effect = (key: string) => (e: RetraceEvent) => e.type === "effect" && e.key === key;

/** The same log as a build that predates the digests would have written it. */
function undigested(events: readonly RetraceEvent[], drop: "facets" | "both"): RetraceEvent[] {
  const copy = structuredClone(events) as RetraceEvent[];
  for (const e of copy) {
    if (e.type !== "effect") continue;
    delete e.requestFacets;
    if (drop === "both") delete e.requestHash;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// The rebuild is the loop's own request assembly, or it is worth nothing
// ---------------------------------------------------------------------------

test("the requests rebuilt from a log are the requests the provider was handed", async () => {
  const store = new MemoryStore();
  const provider = new MockProvider(script());
  await run("explain alpha and beta", { agent, provider, tools: [lookup], store, runId: "r" });

  const rebuilt = rebuildRequests(store.read("r"));
  const models = rebuilt.calls.filter((c) => c.kind === "model");

  assert.equal(models.length, provider.calls.length, "one rebuilt request per call the provider saw");
  for (const [i, call] of models.entries()) {
    assert.equal(call.kind, "model");
    if (call.kind !== "model") return;
    assert.equal(
      requestFingerprint(call.request),
      requestFingerprint(provider.calls[i]!),
      `step ${i}: the rebuilt request is not the one the provider was given`,
    );
  }
});

test("a rebuilt tool call carries the input the model asked it with", async () => {
  const store = new MemoryStore();
  await record(store, "r");

  const tools = rebuildRequests(store.read("r")).calls.filter((c) => c.kind === "tool");

  assert.deepEqual(
    tools.map((c) => (c.kind === "tool" ? [c.effect.key, c.call.input] : [])),
    [
      ["step:0#0:lookup", { term: "alpha" }],
      ["step:1#0:lookup", { term: "beta" }],
    ],
  );
});

test("the messages a log records are the messages its effects build", async () => {
  const store = new MemoryStore();
  const result = await record(store, "r");

  const rebuilt = rebuildRequests(store.read("r"));

  // The run's own message list is the input plus everything the loop appended;
  // the rebuild only reproduces the appended half, which is what the log holds.
  assert.deepEqual(rebuilt.messages.map((m) => m.message), result.messages.slice(1));
});

// ---------------------------------------------------------------------------
// Every shape a run can end in
// ---------------------------------------------------------------------------

/** Each of these records a run some other way and asks whether it holds up. */
const shapes: Record<string, (store: MemoryStore) => Promise<unknown>> = {
  "a plain multi-step run": (store) => record(store, "r"),

  "a run that declared no tools": (store) =>
    run("just answer", {
      agent: defineAgent({ name: "plain", model: "claude-opus-5" }),
      provider: new MockProvider(answer()),
      store,
      runId: "r",
    }),

  "a streamed run": (store) =>
    run("explain alpha and beta", {
      agent,
      provider: new StreamingMockProvider(script()),
      tools: [lookup],
      store,
      runId: "r",
      onStream: () => {},
    }),

  "a step whose tool calls ran at once": (store) =>
    run("both at once", {
      agent: defineAgent({ name: "parallel", model: "claude-opus-5", parallelTools: true }),
      provider: new MockProvider([
        {
          content: [
            toolUse("t1", "lookup", { term: "alpha" }),
            toolUse("t2", "lookup", { term: "beta" }),
          ],
        },
        { content: [text("both")] },
      ]),
      tools: [lookup],
      store,
      runId: "r",
    }),

  "a tool that read the clock, an id and a die": (store) =>
    run("stamp it", {
      agent,
      provider: new MockProvider([
        { content: [toolUse("t1", "stamp", { what: "x" })] },
        { content: [text("stamped")] },
      ]),
      tools: [
        tool({
          name: "stamp",
          description: "Stamp a thing with the time and an id.",
          inputSchema: objectSchema({ what: { type: "string" } }),
          run: async (input: { what: string }, ctx) =>
            `${input.what} ${await ctx.uuid()} ${await ctx.now()} ${await ctx.random()}`,
        }),
      ],
      store,
      runId: "r",
    }),

  "a tool that threw": (store) =>
    run("break it", {
      agent,
      provider: new MockProvider([
        { content: [toolUse("t1", "boom", {})] },
        { content: [text("recovered")] },
      ]),
      tools: [
        tool({
          name: "boom",
          description: "Always fails.",
          inputSchema: objectSchema({}),
          run: () => {
            throw new Error("no");
          },
        }),
      ],
      store,
      runId: "r",
    }),

  "a model call the model refused": (store) =>
    run("no", {
      agent,
      provider: new MockProvider([{ content: [text("I won't")], stopReason: "refusal" }]),
      tools: [lookup],
      store,
      runId: "r",
    }),

  "a run that ran out of steps": (store) =>
    run("go forever", {
      agent: defineAgent({ name: "looper", model: "claude-opus-5", maxSteps: 2 }),
      provider: new MockProvider([
        { content: [toolUse("t1", "lookup", { term: "alpha" })] },
        { content: [toolUse("t2", "lookup", { term: "beta" })] },
      ]),
      tools: [lookup],
      store,
      runId: "r",
    }),

  "a run that stopped at its budget mid-step": (store) =>
    run("go", {
      agent: defineAgent({ name: "spender", model: "claude-opus-5", maxSteps: 5 }),
      provider: new MockProvider([
        {
          content: [
            toolUse("t1", "lookup", { term: "alpha" }),
            toolUse("t2", "lookup", { term: "beta" }),
          ],
        },
      ]),
      tools: [lookup],
      budget: { toolCalls: 1 },
      store,
      runId: "r",
    }),

  "a run the model threw on": (store) =>
    run("break", {
      agent,
      provider: new (class extends MockProvider {
        async complete(request: ModelRequest): Promise<ModelResponse> {
          if (this.callCount > 0) throw new Error("the model is overloaded, try again");
          return super.complete(request);
        }
      })([{ content: [toolUse("t1", "lookup", { term: "alpha" })] }]),
      tools: [lookup],
      store,
      runId: "r",
    }).catch(() => {}),

  "a fork with a rewritten prompt": async (store) => {
    await record(store, "parent");
    await fork("parent", {
      provider: new MockProvider(answer()),
      tools: [lookup],
      atStep: 2,
      agent: { system: "Answer in ten words." },
      store,
      runId: "r",
    });
  },

  "a fork re-entered inside a step": async (store) => {
    await record(store, "parent");
    await fork("parent", {
      provider: new MockProvider([{ content: [text("done")] }]),
      tools: [lookup],
      atEffect: "step:1#0:lookup",
      store,
      runId: "r",
    });
  },

  "a counterfactual fork": async (store) => {
    await record(store, "parent");
    await fork("parent", {
      provider: new MockProvider(answer()),
      tools: [lookup],
      atStep: 2,
      overrides: { "step:0#0:lookup": "nothing found" },
      store,
      runId: "r",
    });
  },

  "a resumed run": async (store) => {
    const full = await record(store, "parent");
    // A killed log: everything up to and including step 1's model call.
    let effects = 0;
    for (const event of full.events) {
      if (event.type === "run.finished") break;
      if (event.type === "effect" && effects++ === 3) break;
      store.append("killed", event);
    }
    await resume("killed", {
      provider: new MockProvider(answer()),
      tools: [lookup],
      store,
      runId: "r",
    });
  },
};

for (const [shape, record_] of Object.entries(shapes)) {
  test(`${shape} is an answer to its own questions`, async () => {
    const store = new MemoryStore();
    await record_(store);

    const check = requests(store.read("r"));

    assert.equal(check.status, "ok", check.detail);
    assert.match(check.detail, /answer the request this log rebuilds, digest for digest/);
  });
}

test("the log a run was killed part-way through is checked as far as it goes", async () => {
  const store = new MemoryStore();
  const full = await record(store, "parent");

  // Cut between step 1's model call and the tool call it asked for: the log
  // holds a question whose answer was never written down.
  let effects = 0;
  for (const event of full.events) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && effects++ === 3) break;
    store.append("killed", event);
  }

  const check = requests(store.read("killed"));

  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /^3 calls answer/, "the three calls the log does hold were checked");
});

// ---------------------------------------------------------------------------
// What it catches, which is the point
// ---------------------------------------------------------------------------

test("a tool result edited in the log stops being the answer the next step was given", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const doctored = tampered(events, effect("step:0#0:lookup"), (e) => {
    if (e.type === "effect") e.value = { content: "definition of something else", isError: false };
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /model:step:1 was recorded against a request this log does not build/);
  assert.match(check.detail, /conversation moved/);
});

test("the answer a run ended on is held to the log even though no step read it", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  // Step 2's own digest was taken before it answered, and nothing downstream
  // rebuilt a request out of what it said — so the messages are what is left to
  // hold the last turn of a run to.
  const doctored = tampered(events, effect("step:2"), (e) => {
    if (e.type === "effect") (e.value as ModelResponse).content = [text("something else entirely")];
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /the assistant message recorded at step 2 is not the one this log's effects build/);
});

test("a model response asking for a different call than the one recorded beside it", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const doctored = tampered(events, effect("step:0"), (e) => {
    if (e.type === "effect") {
      (e.value as ModelResponse).content = [toolUse("t1", "lookup", { term: "gamma" })];
    }
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(
    check.detail,
    /tool:step:0#0:lookup holds the answer to a different input than the response above it asks for/,
  );
});

test("each part of a request the log can be edited in names itself", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const moved = (edit: (started: Extract<RetraceEvent, { type: "run.started" }>) => void): string => {
    const doctored = tampered(events, (e) => e.type === "run.started", (e) => {
      if (e.type === "run.started") edit(e);
    });
    const check = requests(doctored);
    assert.equal(check.status, "failed", check.detail);
    return check.detail;
  };

  const spec = (started: Extract<RetraceEvent, { type: "run.started" }>): AgentSpec => started.agent;

  assert.match(moved((s) => void (spec(s).system = "a prompt it never had")), /system moved/);
  assert.match(moved((s) => void (spec(s).model = "claude-sonnet-5")), /model moved/);
  assert.match(moved((s) => void (spec(s).maxTokens = 99)), /settings moved/);
  assert.match(moved((s) => void (s.tools = [])), /tools moved/);
  assert.match(moved((s) => void (s.input = "a question it was never asked")), /conversation moved/);
});

test("an effect spliced into a log is an answer to a call nothing in it makes", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const doctored = structuredClone(events) as RetraceEvent[];
  const genuine = doctored.find(effect("step:0#0:lookup"))!;
  assert.equal(genuine.type, "effect");
  if (genuine.type !== "effect") return;
  doctored.splice(doctored.indexOf(genuine) + 1, 0, {
    ...genuine,
    key: "step:0#1:lookup",
    value: { content: "definition of gamma", isError: false },
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /tool:step:0#1:lookup is in the log, and nothing in it asks for that call/);
});

test("a message event doctored on its own is caught even when every digest holds", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const doctored = tampered(
    events,
    (e) => e.type === "message" && e.message.role === "user",
    (e) => {
      if (e.type === "message" && e.message.role === "user") {
        e.message.content = [{ type: "text", text: "not what the tool said" }];
      }
    },
  );

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /the user message recorded at step 0 is not the one this log's effects build/);
});

test("a model call recorded with neither a value nor a failure has nothing past it", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const doctored = tampered(events, effect("step:1"), (e) => {
    if (e.type === "effect") e.value = null;
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /model:step:1 records neither a value nor a failure/);
});

// ---------------------------------------------------------------------------
// What it declines to guess at
// ---------------------------------------------------------------------------

test("a log recorded before runs declared their tools is reported unchecked, not edited", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const older = tampered(events, (e) => e.type === "run.started", (e) => {
    if (e.type === "run.started") delete e.tools;
  });

  const check = requests(older);
  assert.equal(check.status, "skipped");
  assert.match(check.detail, /predates the tool declarations/);
});

test("a log whose calls carry no request digest is reported unchecked, not passed", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  const check = requests(undigested(events, "both"));
  assert.equal(check.status, "skipped");
  assert.match(check.detail, /none of its 5 calls carries a request digest/);
});

test("a digest with no facets beside it says what moved and not which part", async () => {
  const store = new MemoryStore();
  const { events } = await record(store, "r");

  // An older log: the whole-request digest, and no components to compare.
  const doctored = tampered(undigested(events, "facets"), effect("step:0#0:lookup"), (e) => {
    if (e.type === "effect") e.value = { content: "moved", isError: false };
  });

  const check = requests(doctored);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /model:step:1 was recorded against a request this log does not build$/);
});

// ---------------------------------------------------------------------------
// The reason it exists: a lineage has to bottom out somewhere
// ---------------------------------------------------------------------------

test("a doctored original is caught in its own log, and nowhere else in its lineage", async () => {
  const recorded = new MemoryStore();
  const { events } = await record(recorded, "original");

  // Change what the corpus said at step 0, in the run that executed it, and
  // hand the edited log to a store as the only copy anyone will ever see.
  const store = new MemoryStore();
  for (const event of tampered(events, effect("step:0#0:lookup"), (e) => {
    if (e.type === "effect") e.value = { content: "definition of something else", isError: false };
  })) {
    store.append("original", event);
  }
  await fork("original", {
    provider: new MockProvider(answer()),
    tools: [lookup],
    atStep: 2,
    store,
    runId: "forked",
  });

  // Every other check compares one log with another. The fork replayed the
  // edited value faithfully, so `parent` holds and `lineage` traces it back to
  // the run that executed and paid for it; the totals still add up; nothing in
  // the shape of either log is out of place. On its own that is a lineage that
  // verifies, rooted in a run that never happened.
  const original = verifyRun("original", store);
  assert.deepEqual(
    original.checks.filter((c) => c.status === "failed").map((c) => c.name),
    ["requests"],
    "the log's own questions are the only thing with anything to say about this",
  );
  assert.match(
    original.checks.find((c) => c.name === "requests")!.detail,
    /model:step:1 was recorded against a request this log does not build — conversation moved/,
  );

  // And the fork is not implicated, correctly: it was served this value and
  // built its requests around it, so its log is a truthful record of the run it
  // had. The edit is caught where it was made.
  const forked = verifyRun("forked", store);
  assertOk(forked, "requests");
  assertOk(forked, "parent");
  assertOk(forked, "lineage");
  assert.equal(forked.ok, true);
});

function assertOk(report: VerifyReport, name: string): void {
  const check = report.checks.find((c) => c.name === name);
  assert.ok(check, `the report has no check called "${name}"`);
  assert.equal(check.status, "ok", `${name}: ${check.detail}`);
}
