import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import {
  ambientEffects,
  defineAgent,
  describeFetch,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  recheckEvents,
  renderReport,
  summarize,
  replay,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  verifyEvents,
  type RecordedFetch,
  type RetraceEvent,
  type Tool,
  type ToolContext,
} from "../src/index.ts";

const agent = defineAgent({ name: "reader", model: "claude-opus-5", maxSteps: 6 });

/**
 * A `fetch` that never leaves the process, and counts what it was asked.
 *
 * Every test here runs with no network, which is the point: what is being
 * checked is that the journal serves the recorded answer rather than reaching
 * for one, and a test that reached the network could not tell the difference.
 */
function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    asked.push(url);
    return answer(url);
  }) as typeof globalThis.fetch;
  return {
    asked,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A tool that answers out of the corpus at `https://corpus.test`. */
function lookupTool(via: "ctx" | "global" = "ctx") {
  return tool({
    name: "search",
    description: "Search the corpus for a term. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const url = `https://corpus.test/search?q=${input.query}`;
      const response = await (via === "ctx" ? ctx.fetch(url) : globalThis.fetch(url));
      const body = (await response.json()) as { hits: string };
      return `${response.status} ${body.hits}`;
    },
  });
}

/**
 * Two searches in two steps, so a fork at step 1 replays one whole step and
 * runs the other live. A tool call that replays never executes, so a live tail
 * is the only place a tool body runs against a response out of the log — which
 * is where most of what is worth checking here happens.
 */
function script(...queries: string[]) {
  const asked = queries.length > 0 ? queries : ["alpha", "beta"];
  return [
    ...asked.map((query, i) => ({ content: [toolUse(`t${i}`, "search", { query })] })),
    { content: [text("read it")] },
  ];
}

function fetches(events: readonly RetraceEvent[]) {
  return effectsOf(events).filter((e) => e.kind === "fetch");
}

async function record(options: { store?: RunStore; runId?: string; tools?: Tool[] } = {}) {
  const store = options.store ?? new MemoryStore();
  const stub = stubFetch((url) => json({ hits: `results for ${new URL(url).searchParams.get("q")}` }));
  try {
    const result = await run("read the corpus", {
      agent,
      provider: new MockProvider(script()),
      tools: options.tools ?? [lookupTool()],
      store,
      runId: options.runId ?? "read",
    });
    return { store, result, asked: [...stub.asked] };
  } finally {
    stub.restore();
  }
}

test("a fetch a tool made through ctx lands in the log, with what it asked", async () => {
  const { result, asked } = await record();

  assert.deepEqual(asked, [
    "https://corpus.test/search?q=alpha",
    "https://corpus.test/search?q=beta",
  ]);
  const [recorded] = fetches(result.events);
  assert.ok(recorded);
  assert.equal(recorded.step, 0);
  assert.match(recorded.key, /^step:0#0:search\/fetch:0:[0-9a-f]{12}$/);

  const value = recorded.value as RecordedFetch;
  assert.deepEqual(value.request, { method: "GET", url: "https://corpus.test/search?q=alpha" });
  assert.equal(value.status, 200);
  assert.equal(value.statusText, "OK");
  assert.equal(value.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(value.body), { hits: "results for alpha" });
  assert.equal(result.output, "read it");
});

test("a replay serves the recorded responses and never reaches the network", async () => {
  const { store, result } = await record();

  // No stub at all: a replay that tried to fetch would reach the real network
  // and fail, rather than quietly passing against a stub that answered anyway.
  const again = await replay("read", { provider: new MockProvider([]), tools: [lookupTool()], store });

  assert.equal(again.status, "completed");
  assert.equal(again.output, result.output);
  assert.deepEqual(
    fetches(again.events).map((e) => e.replayed),
    [true, true],
  );
  assert.deepEqual(
    fetches(again.events).map((e) => e.value),
    fetches(result.events).map((e) => e.value),
  );
  assert.deepEqual(
    fetches(again.events).map((e) => e.durationMs),
    [0, 0],
  );
});

/**
 * A tool call that replays never executes, so the only place a tool body meets
 * a response that came out of the log is the live tail of a fork. These two
 * record a run, then fork at step 1 so that step's search runs for real against
 * the response its parent recorded.
 */
async function forkOntoRecordedResponse(store: RunStore, tools: Tool[], runId: string) {
  return fork("read", {
    provider: new MockProvider([
      { content: [toolUse("t1", "search", { query: "beta" })] },
      { content: [text("read it")] },
    ]),
    atStep: 1,
    tools,
    store,
    runId,
  });
}

test("the response a tool sees is rebuilt from the log, headers, status text and url", async () => {
  const seen: unknown[] = [];
  const inspecting = tool({
    name: "search",
    description: "Search the corpus for a term. Call this whenever the answer depends on a fact.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const r = await ctx.fetch(`https://corpus.test/search?q=${input.query}`);
      seen.push({
        url: r.url,
        status: r.status,
        statusText: r.statusText,
        type: r.headers.get("content-type") ?? "",
        body: await r.text(),
      });
      return "read";
    },
  });

  const store = new MemoryStore();
  const stub = stubFetch(
    (url) =>
      new Response(`hits for ${new URL(url).searchParams.get("q")}`, {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/plain;charset=utf-8" },
      }),
  );
  try {
    await run("read", {
      agent,
      provider: new MockProvider(script()),
      tools: [inspecting],
      store,
      runId: "read",
    });
    seen.length = 0;
    await forkOntoRecordedResponse(store, [inspecting], "again");
  } finally {
    stub.restore();
  }

  // Live and replayed responses are built by the same code from the same
  // record, so a tool cannot behave one way while being recorded and another
  // way afterwards — and nothing was asked of the network the second time.
  assert.deepEqual(stub.asked, [
    "https://corpus.test/search?q=alpha",
    "https://corpus.test/search?q=beta",
  ]);
  assert.deepEqual(seen, [
    {
      url: "https://corpus.test/search?q=beta",
      status: 201,
      statusText: "Created",
      type: "text/plain;charset=utf-8",
      body: "hits for beta",
    },
  ]);
});

test("bytes that are not text round-trip through the log as base64", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
  const seen: number[][] = [];

  const binary = tool({
    name: "search",
    description: "Fetch an image from the corpus. Call this when the answer is a picture.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const r = await ctx.fetch(`https://corpus.test/search?q=${input.query}`);
      seen.push([...new Uint8Array(await r.arrayBuffer())]);
      return "read";
    },
  });

  const store = new MemoryStore();
  const stub = stubFetch(() => new Response(bytes, { status: 200 }));
  try {
    await run("read", { agent, provider: new MockProvider(script()), tools: [binary], store, runId: "read" });
    assert.deepEqual(seen, [[...bytes], [...bytes]]);
    seen.length = 0;
    await forkOntoRecordedResponse(store, [binary], "again");
  } finally {
    stub.restore();
  }

  assert.equal((fetches(store.read("read"))[0]?.value as RecordedFetch).base64, true);
  assert.equal(stub.asked.length, 2);
  assert.deepEqual(seen, [[...bytes]]);
});

test("a fetch that rejected is recorded, and rejects again on replay without calling out", async () => {
  const store = new MemoryStore();
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed: corpus.test is down");
  });
  try {
    await run("read", {
      agent,
      provider: new MockProvider(script()),
      tools: [lookupTool()],
      store,
      runId: "down",
    });
  } finally {
    stub.restore();
  }

  const [recorded] = fetches(store.read("down"));
  assert.deepEqual((recorded?.value as RecordedFetch).error, {
    name: "TypeError",
    message: "fetch failed: corpus.test is down",
  });

  // A tool catches its own throw into an error result, so what proves the
  // rejection was reproduced is that the tool said the same thing about it.
  const recordedResult = effectsOf(store.read("down")).find((e) => e.kind === "tool");
  const again = await replay("down", { provider: new MockProvider([]), tools: [lookupTool()], store });
  const replayedResult = effectsOf(again.events).find((e) => e.kind === "tool");
  assert.deepEqual(replayedResult?.value, recordedResult?.value);
  assert.match(String((replayedResult?.value as { content: string }).content), /corpus\.test is down/);
});

test("a fork's live tail is served the response its parent recorded for the same request", async () => {
  const { store } = await record();

  // Step 0 replays whole; step 1's search executes for real, and asks the
  // corpus what the parent asked it at that same slot.
  const forked = await forkOntoRecordedResponse(store, [lookupTool()], "same-question");

  assert.equal(forked.status, "completed");
  assert.deepEqual(
    fetches(forked.events).map((e) => e.replayed),
    [true, true],
  );
  assert.deepEqual(
    fetches(forked.events).map((e) => e.value),
    fetches(store.read("read")).map((e) => e.value),
  );
});

test("a live tail asking something else finds no answer in that slot and goes to the network", async () => {
  const { store } = await record();

  const stub = stubFetch((url) => json({ hits: `fresh for ${new URL(url).searchParams.get("q")}` }));
  let forked;
  try {
    forked = await fork("read", {
      provider: new MockProvider([
        { content: [toolUse("t1", "search", { query: "gamma" })] },
        { content: [text("read something else")] },
      ]),
      atStep: 1,
      tools: [lookupTool()],
      store,
      runId: "new-question",
    });
  } finally {
    stub.restore();
  }

  // The slot is the same — step 1's first search, its first fetch — and the
  // request is not, which is the whole of what the digest in the key buys: the
  // parent's answer about "beta" is never handed to a call asking about
  // "gamma".
  assert.deepEqual(stub.asked, ["https://corpus.test/search?q=gamma"]);
  const [asked] = fetches(forked.events).filter((e) => !e.replayed);
  assert.ok(asked?.key.startsWith("step:1#0:search/fetch:0:"));
  assert.equal((asked.value as RecordedFetch).request.url, "https://corpus.test/search?q=gamma");
});

test("a tool that fetches around ctx is marked, and verify's ambient check fails on it", async () => {
  const store = new MemoryStore();
  const stub = stubFetch(() => json({ hits: "results for alpha" }));
  try {
    await run("read", {
      agent,
      provider: new MockProvider(script()),
      tools: [lookupTool("global")],
      store,
      runId: "loose",
    });
  } finally {
    stub.restore();
  }

  const events = store.read("loose");
  assert.deepEqual(fetches(events), []);
  assert.deepEqual(
    ambientEffects(events).map((e) => [e.key, e.ambient]),
    [
      ["step:0#0:search", ["network"]],
      ["step:1#0:search", ["network"]],
    ],
  );

  const ambient = verifyEvents("loose", events, undefined).checks.find((c) => c.name === "ambient");
  assert.equal(ambient?.status, "failed");
  assert.match(ambient.detail, /read the network outside the journal/);
});

test("a run whose tools fetch through ctx verifies clean", async () => {
  const { store } = await record();
  const report = verifyEvents("read", store.read("read"), store);

  assert.equal(report.ok, true);
  const ambient = report.checks.find((c) => c.name === "ambient");
  assert.equal(ambient?.status, "ok");
  assert.match(ambient.detail, /none of which read a clock, an id, an RNG or the network outside ctx/);
});

test("recheck asks the network again rather than replaying what the log holds", async () => {
  const { store } = await record();

  const stub = stubFetch(() => json({ hits: "results for alpha, and two more" }));
  let report;
  try {
    report = await recheckEvents("read", store.read("read"), { tools: [lookupTool()] });
  } finally {
    stub.restore();
  }

  // Two executions, because the first disagreed and a disagreement is asked
  // again to tell a moved corpus from a tool with no settled answer.
  assert.equal(stub.asked.length, 4);
  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["moved", "moved"],
  );
  assert.equal(report.ok, false);
});

test("recheck reports a corpus that has not moved as unchanged", async () => {
  const { store } = await record();

  const stub = stubFetch((url) => json({ hits: `results for ${new URL(url).searchParams.get("q")}` }));
  let report;
  try {
    report = await recheckEvents("read", store.read("read"), { tools: [lookupTool()] });
  } finally {
    stub.restore();
  }

  assert.equal(stub.asked.length, 2);
  assert.deepEqual(
    report.calls.map((c) => c.status),
    ["same", "same"],
  );
});

test("the report says what was fetched, which the key only digests", async () => {
  const { store, result } = await record();
  const value = fetches(result.events)[0]?.value as RecordedFetch;

  assert.equal(
    describeFetch(value),
    `GET https://corpus.test/search?q=alpha → 200 (${value.body.length}B)`,
  );

  const events = store.read("read");
  const html = renderReport(summarize("read", events), events);
  assert.ok(html.includes("GET https://corpus.test/search?q=alpha"));
  assert.ok(!html.includes("<script"));
});

test("show says what was fetched, under the call that fetched it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-fetch-"));
  const written: string[] = [];
  try {
    await record({ store: new RunStore(dir) });
    const code = await main(["show", "read", "--dir", dir], {
      out: (s: string) => void written.push(s),
      err: () => {},
    });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The key digests the request, so without this line the timeline says which
  // slot answered and never what it was asked.
  const shown = written.join("");
  assert.match(shown, /fetch\s+.*step:0#0:search\/fetch:0:[0-9a-f]{12}/);
  assert.match(shown, /GET https:\/\/corpus\.test\/search\?q=alpha → 200 \(\d+B\)/);
});

test("overlapping tool calls leave the same fetches in the log as sequential ones", async () => {
  // Three searches in one step, so `parallelTools` has three bodies in flight
  // and three responses settling in whatever order the network gives them.
  const oneStep = [
    { content: ["alpha", "beta", "gamma"].map((query, i) => toolUse(`t${i}`, "search", { query })) },
    { content: [text("read it")] },
  ];

  const both = [];
  for (const parallelTools of [false, true]) {
    const store = new MemoryStore();
    const stub = stubFetch(async (url) => {
      // Answering out of order is the whole hazard: the log has to come out in
      // the order the model asked, not the order the corpus replied.
      const q = new URL(url).searchParams.get("q") ?? "";
      await new Promise((done) => setTimeout(done, q === "alpha" ? 12 : 1));
      return json({ hits: `results for ${q}` });
    });
    try {
      await run("read the corpus", {
        agent: { ...agent, parallelTools },
        provider: new MockProvider(oneStep),
        tools: [lookupTool()],
        store,
        runId: "read",
      });
    } finally {
      stub.restore();
    }
    both.push(fetches(store.read("read")).map((e) => ({ key: e.key, value: e.value })));
  }

  assert.deepEqual(
    both[0]?.map((e) => e.key.split("/")[0]),
    ["step:0#0:search", "step:0#1:search", "step:0#2:search"],
  );
  assert.deepEqual(both[0], both[1]);
});

test("a fetch is not a fork point: it resolves by key, wherever the run reaches it", async () => {
  const { store } = await record();
  const key = fetches(store.read("read"))[0]?.key;
  assert.ok(key);

  await assert.rejects(
    () =>
      fork("read", {
        provider: new MockProvider([]),
        atEffect: key,
        tools: [lookupTool()],
        store,
        runId: "nope",
      }),
    /fork point is a model or tool call/,
  );
});
