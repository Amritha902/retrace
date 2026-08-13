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
  run,
  text,
  tool,
  toolUse,
  type RetraceEvent,
  type ToolContext,
} from "../src/index.ts";

const sequential = defineAgent({ name: "gatherer", model: "claude-opus-5", maxSteps: 6 });
const atOnce = defineAgent({ ...sequential, parallelTools: true });

/**
 * A latch that opens once `n` callers are inside it, and gives up if they never
 * all arrive. Two tools that both wait on it finish only if they were running
 * at the same time, which is the thing under test — and the timeout is what
 * keeps the sequential case from hanging the suite instead of failing it.
 */
function meeting(n: number, timeoutMs = 500) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let arrived = 0;

  return async (): Promise<void> => {
    if (++arrived >= n) open();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ran alone")), timeoutMs);
    });
    try {
      await Promise.race([opened, expired]);
    } finally {
      clearTimeout(timer!);
    }
  };
}

function meetingTool(name: string, meet: () => Promise<void>) {
  return tool({
    name,
    description: "Wait until the rest of this step's tools are running too.",
    inputSchema: objectSchema({}),
    run: async () => {
      await meet();
      return `${name} met`;
    },
  });
}

function echoTool() {
  return tool({
    name: "echo",
    description: "Repeat a value back. Call this when you need something written down.",
    inputSchema: objectSchema({ value: { type: "string" } }),
    run: (input: { value: string }) => input.value,
  });
}

/** Reads the clock and an id, and counts its executions so a replay can be proven. */
function stampTool() {
  let runs = 0;
  return {
    runs: () => runs,
    tool: tool({
      name: "stamp",
      description: "Stamp a label with the time and a fresh id. Call this to file a record.",
      inputSchema: objectSchema({ label: { type: "string" } }),
      run: async (input: { label: string }, ctx: ToolContext) => {
        runs++;
        return `${input.label} at ${await ctx.now()} as ${await ctx.uuid()}`;
      },
    }),
  };
}

/** Every effect in the log, minus the parts that are allowed to differ. */
function journalOf(events: readonly RetraceEvent[]) {
  return effectsOf(events).map(({ index, kind, key, value, replayed }) => ({
    index,
    kind,
    key,
    value,
    replayed,
  }));
}

/** The shape of the log: which effect claimed which slot, values aside. */
function slotsOf(events: readonly RetraceEvent[]) {
  return effectsOf(events).map((e) => `${e.index} ${e.kind}:${e.key}`);
}

function twoToolScript() {
  return [
    { content: [toolUse("t1", "alpha", {}), toolUse("t2", "beta", {})] },
    { content: [text("done")] },
  ];
}

test("a step's tool calls overlap when the agent asks them to", async () => {
  const meet = meeting(2);
  const result = await run("gather", {
    agent: atOnce,
    provider: new MockProvider(twoToolScript()),
    tools: [meetingTool("alpha", meet), meetingTool("beta", meet)],
    store: new MemoryStore(),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    effectsOf(result.events)
      .filter((e) => e.kind === "tool")
      .map((e) => e.value),
    [
      { content: "alpha met", isError: false },
      { content: "beta met", isError: false },
    ],
  );
});

test("and run one after another when it doesn't", async () => {
  const meet = meeting(2);
  const result = await run("gather", {
    agent: sequential,
    provider: new MockProvider(twoToolScript()),
    tools: [meetingTool("alpha", meet), meetingTool("beta", meet)],
    store: new MemoryStore(),
  });

  // alpha waits for a beta that cannot start until alpha is done, gives up, and
  // hands the model the error. Only then does beta run, and by then the latch
  // is open.
  assert.deepEqual(
    effectsOf(result.events)
      .filter((e) => e.kind === "tool")
      .map((e) => e.value),
    [
      { content: "ran alone", isError: true },
      { content: "beta met", isError: false },
    ],
  );
});

test("a parallel step writes the log a sequential one would have", async () => {
  const script = () => [
    { content: [toolUse("t1", "echo", { value: "a" }), toolUse("t2", "echo", { value: "b" })] },
    { content: [toolUse("t3", "echo", { value: "c" })] },
    { content: [text("done")] },
  ];

  const one = await run("gather", {
    agent: sequential,
    provider: new MockProvider(script()),
    tools: [echoTool()],
    store: new MemoryStore(),
  });
  const many = await run("gather", {
    agent: atOnce,
    provider: new MockProvider(script()),
    tools: [echoTool()],
    store: new MemoryStore(),
  });

  assert.deepEqual(journalOf(many.events), journalOf(one.events));
  assert.deepEqual(many.messages, one.messages);
});

test("results come back in the order the model asked for them", async () => {
  const slow = tool({
    name: "slow",
    description: "Take a while. Call this when the answer is expensive to get.",
    inputSchema: objectSchema({}),
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "slow";
    },
  });
  const quick = tool({
    name: "quick",
    description: "Answer immediately. Call this when the answer is cheap.",
    inputSchema: objectSchema({}),
    run: () => "quick",
  });

  const result = await run("gather", {
    agent: atOnce,
    provider: new MockProvider([
      { content: [toolUse("t1", "slow", {}), toolUse("t2", "quick", {})] },
      { content: [text("done")] },
    ]),
    tools: [slow, quick],
    store: new MemoryStore(),
  });

  assert.deepEqual(slotsOf(result.events), [
    "0 model:step:0",
    "1 tool:step:0#0:slow",
    "2 tool:step:0#1:quick",
    "3 model:step:1",
  ]);
  const toolResults = result.messages[2];
  assert.equal(toolResults?.role, "user");
  assert.deepEqual(
    toolResults.content.map((b) => (b.type === "tool_result" ? b.toolUseId : b.type)),
    ["t1", "t2"],
  );
});

test("clock and id reads keep their slots when the tools overlap", async () => {
  const script = () => [
    {
      content: [
        toolUse("t1", "stamp", { label: "first" }),
        toolUse("t2", "stamp", { label: "second" }),
      ],
    },
    { content: [text("filed")] },
  ];

  const one = await run("file two records", {
    agent: sequential,
    provider: new MockProvider(script()),
    tools: [stampTool().tool],
    store: new MemoryStore(),
  });
  const many = await run("file two records", {
    agent: atOnce,
    provider: new MockProvider(script()),
    tools: [stampTool().tool],
    store: new MemoryStore(),
  });

  // The timestamps differ between two live runs; the slots they land in must not.
  assert.deepEqual(slotsOf(many.events), slotsOf(one.events));
  assert.deepEqual(slotsOf(many.events), [
    "0 model:step:0",
    "1 tool:step:0#0:stamp",
    "2 clock:step:0#0:stamp/clock:0",
    "3 uuid:step:0#0:stamp/uuid:0",
    "4 tool:step:0#1:stamp",
    "5 clock:step:0#1:stamp/clock:0",
    "6 uuid:step:0#1:stamp/uuid:0",
    "7 model:step:1",
  ]);
});

test("a parallel run replays without executing anything", async () => {
  const store = new MemoryStore();
  const stamp = stampTool();
  const original = await run("file two records", {
    agent: atOnce,
    provider: new MockProvider([
      {
        content: [
          toolUse("t1", "stamp", { label: "first" }),
          toolUse("t2", "stamp", { label: "second" }),
        ],
      },
      { content: [text("filed")] },
    ]),
    tools: [stamp.tool],
    store,
    runId: "at-once",
  });
  assert.equal(stamp.runs(), 2);

  const replayStamp = stampTool();
  const provider = new MockProvider([]);
  const again = await replay("at-once", {
    provider,
    tools: [replayStamp.tool],
    store,
    runId: "at-once-again",
  });

  assert.equal(again.status, "completed");
  assert.equal(again.output, original.output);
  assert.equal(replayStamp.runs(), 0, "a replayed tool must not execute");
  assert.equal(provider.callCount, 0);
  assert.deepEqual(
    journalOf(again.events).map((e) => ({ ...e, replayed: undefined })),
    journalOf(original.events).map((e) => ({ ...e, replayed: undefined })),
  );
  assert.ok(journalOf(again.events).every((e) => e.replayed));
});

test("a fork re-runs a parallel step at once, on the parent's clock", async () => {
  const store = new MemoryStore();
  const script = () => [
    {
      content: [
        toolUse("t1", "stamp", { label: "first" }),
        toolUse("t2", "stamp", { label: "second" }),
      ],
    },
    {
      content: [
        toolUse("t3", "stamp", { label: "third" }),
        toolUse("t4", "stamp", { label: "fourth" }),
      ],
    },
    { content: [text("filed")] },
  ];

  const parent = await run("file four records", {
    agent: atOnce,
    provider: new MockProvider(script()),
    tools: [stampTool().tool],
    store,
    runId: "at-once",
  });

  const forkStamp = stampTool();
  const forked = await fork("at-once", {
    // Step 0 comes out of the parent's log; only the live steps need scripting.
    provider: new MockProvider(script().slice(1)),
    tools: [forkStamp.tool],
    atStep: 1,
    store,
    runId: "at-once-fork",
  });

  assert.equal(forkStamp.runs(), 2, "only step 1's tools should have run");
  assert.deepEqual(slotsOf(forked.events), slotsOf(parent.events));

  const live = effectsOf(forked.events).filter((e) => e.key.startsWith("step:1#"));
  assert.ok(
    live.filter((e) => e.kind !== "tool").every((e) => e.replayed),
    "the reads came from the parent's log even though the tools executed",
  );
  assert.deepEqual(
    live.filter((e) => e.kind === "tool").map((e) => e.value),
    effectsOf(parent.events)
      .filter((e) => e.kind === "tool" && e.key.startsWith("step:1#"))
      .map((e) => e.value),
    "same stamps in, same records out",
  );
});

test("a batch that would run out of tool budget is refused whole", async () => {
  const script = () => [
    { content: [toolUse("t1", "echo", { value: "a" }), toolUse("t2", "echo", { value: "b" })] },
    { content: [text("done")] },
  ];

  const calls: string[] = [];
  const counting = tool({
    name: "echo",
    description: "Repeat a value back. Call this when you need something written down.",
    inputSchema: objectSchema({ value: { type: "string" } }),
    run: (input: { value: string }) => {
      calls.push(input.value);
      return input.value;
    },
  });

  const many = await run("gather", {
    agent: atOnce,
    provider: new MockProvider(script()),
    tools: [counting],
    budget: { toolCalls: 1 },
    store: new MemoryStore(),
  });

  assert.equal(many.status, "budget_exceeded");
  assert.deepEqual(calls, [], "the whole batch is charged before any of it starts");

  // Sequentially the first call is already done and logged before the second is
  // refused, which is the honest difference between the two modes.
  calls.length = 0;
  const one = await run("gather", {
    agent: sequential,
    provider: new MockProvider(script()),
    tools: [counting],
    budget: { toolCalls: 1 },
    store: new MemoryStore(),
  });

  assert.equal(one.status, "budget_exceeded");
  assert.deepEqual(calls, ["a"]);
});
