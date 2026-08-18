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

/**
 * A `fetch` that records what it was actually handed to send.
 *
 * Everything below is about a request's body, and the two things worth checking
 * about one are that the log holds it and that reading it left the fetch the
 * bytes it was given — a journal that digested a body by consuming it would
 * send an empty one.
 */
function stubSends(answer: (url: string) => Response) {
  const sent: Array<{ method: string; url: string; bytes: Uint8Array }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bytes = new Uint8Array(await new Request(url, init).arrayBuffer());
    sent.push({ method: init?.method ?? "GET", url, bytes });
    return answer(url);
  }) as typeof globalThis.fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Two steps of writing, so a fork at step 1 has one live call to make. */
function writes(...queries: string[]) {
  return [
    ...queries.map((query, i) => ({ content: [toolUse(`t${i}`, "index", { query })] })),
    { content: [text("written")] },
  ];
}

/** A tool that writes to the corpus, at one URL, with the body it is given. */
function postTool(bodyFor: (query: string) => BodyInit) {
  return tool({
    name: "index",
    description: "Write a term to the corpus. Call this when the answer should be written down.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const r = await ctx.fetch("https://corpus.test/index", {
        method: "POST",
        body: bodyFor(input.query),
      });
      return `${r.status} ${await r.text()}`;
    },
  });
}

test("what a POST sent is in the log, not just where it was sent", async () => {
  const store = new MemoryStore();
  const stub = stubSends(() => new Response("written", { status: 201, statusText: "Created" }));
  try {
    await run("write to the corpus", {
      agent,
      provider: new MockProvider(writes("alpha")),
      tools: [postTool((query) => JSON.stringify({ query }))],
      store,
      runId: "write",
    });
  } finally {
    stub.restore();
  }

  // Without the body the line reads "POST /index → 201", which says the run
  // wrote something to the corpus and never what.
  const value = fetches(store.read("write"))[0]?.value as RecordedFetch;
  assert.deepEqual(value.request, {
    method: "POST",
    url: "https://corpus.test/index",
    body: '{"query":"alpha"}',
  });
  assert.equal(
    describeFetch(value),
    "POST https://corpus.test/index (17B) → 201 (7B)",
  );
});

test("a body that is not a string is read for the log, and still reaches the fetch", async () => {
  const bytes = new Uint8Array([0xff, 0x00, 0x10]);
  const shapes: Array<[string, BodyInit, { body: string; base64?: true }]> = [
    ["a string", "q=alpha", { body: "q=alpha" }],
    ["form parameters", new URLSearchParams({ q: "alpha" }), { body: "q=alpha" }],
    ["a blob", new Blob(["q=alpha"]), { body: "q=alpha" }],
    ["bytes", bytes, { body: Buffer.from(bytes).toString("base64"), base64: true }],
  ];

  for (const [what, body, held] of shapes) {
    const store = new MemoryStore();
    const stub = stubSends(() => new Response("written", { status: 201 }));
    try {
      await run("write to the corpus", {
        agent,
        provider: new MockProvider(writes("alpha")),
        tools: [postTool(() => body)],
        store,
        runId: "write",
      });
    } finally {
      stub.restore();
    }

    const value = fetches(store.read("write"))[0]?.value as RecordedFetch;
    assert.deepEqual(
      { body: value.request.body, ...(value.request.base64 ? { base64: true } : {}) },
      held,
      what,
    );
    // Reading a body to digest it must not consume it: a string, form
    // parameters, a blob and bytes can all be read twice, which is why these
    // are the shapes the journal reads at all.
    assert.deepEqual([...(stub.sent[0]?.bytes ?? [])], [...(await new Response(body).bytes())], what);
  }
});

test("a live tail sending different bytes is not handed the parent's response", async () => {
  // One URL, two bodies: the slot is the same and the request is not, so the
  // digest in the key is the only thing standing between a fork's live call and
  // the parent's answer to a question it did not ask.
  const encode = (query: string) => new TextEncoder().encode(`q=${query}`);

  async function forkWith(query: string, runId: string, store: RunStore) {
    const stub = stubSends(() => new Response(`written ${query}`, { status: 201 }));
    try {
      return {
        forked: await fork("write", {
          provider: new MockProvider([
            { content: [toolUse("t1", "index", { query })] },
            { content: [text("written")] },
          ]),
          atStep: 1,
          tools: [postTool(encode)],
          store,
          runId,
        }),
        sent: [...stub.sent],
      };
    } finally {
      stub.restore();
    }
  }

  const store = new MemoryStore();
  const stub = stubSends(() => new Response("written", { status: 201 }));
  try {
    await run("write to the corpus", {
      agent,
      provider: new MockProvider(writes("alpha", "beta")),
      tools: [postTool(encode)],
      store,
      runId: "write",
    });
  } finally {
    stub.restore();
  }

  const same = await forkWith("beta", "same-bytes", store);
  assert.deepEqual(same.sent, []);
  assert.deepEqual(
    fetches(same.forked.events).map((e) => e.value),
    fetches(store.read("write")).map((e) => e.value),
  );

  const other = await forkWith("gamma", "other-bytes", store);
  assert.deepEqual(other.sent.map((s) => new TextDecoder().decode(s.bytes)), ["q=gamma"]);
  const [live] = fetches(other.forked.events).filter((e) => !e.replayed);
  assert.equal((live?.value as RecordedFetch).request.body, "q=gamma");
});

test("a body the journal cannot read without taking it is recorded as unread", async () => {
  const streaming = tool({
    name: "index",
    description: "Write a term to the corpus. Call this when the answer should be written down.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`q=${input.query}`));
          controller.close();
        },
      });
      const r = await ctx.fetch("https://corpus.test/index", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit);
      return `${r.status} ${await r.text()}`;
    },
  });

  const store = new MemoryStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("written", { status: 201 })) as typeof globalThis.fetch;
  try {
    await run("write to the corpus", {
      agent,
      provider: new MockProvider(writes("alpha")),
      tools: [streaming],
      store,
      runId: "streamed",
    });
  } finally {
    globalThis.fetch = real;
  }

  // Draining the stream would have left the fetch below nothing to send, so the
  // log says it did not read the body rather than recording an empty one — and
  // says it on the line a person reads.
  const value = fetches(store.read("streamed"))[0]?.value as RecordedFetch;
  assert.deepEqual(value.request, {
    method: "POST",
    url: "https://corpus.test/index",
    unread: true,
  });
  assert.equal(
    describeFetch(value),
    "POST https://corpus.test/index (body not read) → 201 (7B)",
  );

  // It is still a stable slot, so the run replays without reaching the network.
  const again = await replay("streamed", {
    provider: new MockProvider([]),
    tools: [streaming],
    store,
  });
  assert.equal(again.status, "completed");
  assert.deepEqual(fetches(again.events).map((e) => e.replayed), [true]);
});

test("a Request carrying its own body is read through a clone, and still sends it", async () => {
  const posting = tool({
    name: "index",
    description: "Write a term to the corpus. Call this when the answer should be written down.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: async (input: { query: string }, ctx: ToolContext) => {
      const r = await ctx.fetch(
        new Request("https://corpus.test/index", { method: "POST", body: `q=${input.query}` }),
      );
      return `${r.status} ${await r.text()}`;
    },
  });

  const store = new MemoryStore();
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    sent.push(await (input as Request).text());
    return new Response("written", { status: 201 });
  }) as typeof globalThis.fetch;
  try {
    await run("write to the corpus", {
      agent,
      provider: new MockProvider(writes("alpha")),
      tools: [posting],
      store,
      runId: "request-body",
    });
  } finally {
    globalThis.fetch = real;
  }

  const value = fetches(store.read("request-body"))[0]?.value as RecordedFetch;
  assert.equal(value.request.body, "q=alpha");
  assert.deepEqual(sent, ["q=alpha"]);
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

test("an override replaces the response and leaves the request it was an answer to", async () => {
  const { store } = await record();
  const key = fetches(store.read("read"))[0]?.key;
  assert.ok(key);

  // At the call rather than at the step: the tool that reads the corpus has to
  // execute for the substitution to reach anything, and forking at the step
  // above it would replay the call along with its fetch.
  const forked = await fork("read", {
    provider: new MockProvider(script()),
    tools: [lookupTool()],
    atEffect: "step:0#0:search",
    overrides: { [key]: JSON.stringify({ hits: "nothing at all" }) },
    store,
    runId: "what-if",
  });

  const [substituted] = fetches(forked.events);
  assert.ok(substituted);
  assert.equal(substituted.overridden, true);
  const value = substituted.value as RecordedFetch;
  // The request is what the tool asked and what the slot is a digest of, so the
  // substitution leaves it alone — and the status and the content type with it,
  // since what was asked was "say something else", not "be a different corpus".
  assert.deepEqual(value.request, { method: "GET", url: "https://corpus.test/search?q=alpha" });
  assert.equal(value.status, 200);
  assert.equal(value.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(value.body), { hits: "nothing at all" });

  const result = effectsOf(forked.events).find((e) => e.kind === "tool");
  assert.equal(result?.replayed, false, "the call at the fork point ran for real");
  assert.equal((result?.value as { content: string }).content, "200 nothing at all");
  assert.equal(verifyEvents("what-if", forked.events, store).ok, true);
});

test("an override that names the response's fields is a corpus that answered differently", async () => {
  const { store } = await record();
  const key = fetches(store.read("read"))[0]?.key;
  assert.ok(key);

  const forked = await fork("read", {
    provider: new MockProvider(script()),
    tools: [lookupTool()],
    atEffect: "step:0#0:search",
    overrides: { [key]: { status: 503, body: JSON.stringify({ hits: "gone" }) } },
    store,
    runId: "what-if-down",
  });

  const value = fetches(forked.events)[0]?.value as RecordedFetch;
  assert.equal(value.status, 503);
  assert.deepEqual(value.request, { method: "GET", url: "https://corpus.test/search?q=alpha" });
  const result = effectsOf(forked.events).find((e) => e.kind === "tool");
  assert.equal((result?.value as { content: string }).content, "503 gone");
});

test("a substituted response still renders, in show and in the report", async () => {
  const { store } = await record();
  const key = fetches(store.read("read"))[0]?.key;
  assert.ok(key);

  const forked = await fork("read", {
    provider: new MockProvider(script()),
    tools: [lookupTool()],
    atEffect: "step:0#0:search",
    overrides: { [key]: JSON.stringify({ hits: "nothing at all" }) },
    store,
    runId: "what-if-shown",
  });

  const line = describeFetch(fetches(forked.events)[0]?.value as RecordedFetch);
  assert.match(line, /^GET https:\/\/corpus\.test\/search\?q=alpha → 200/);
  assert.match(renderReport(summarize("what-if-shown", forked.events), forked.events), /q=alpha/);
});

test("a recorded request edited under its answer fails the reads check", async () => {
  const { store, result } = await record();

  const edited = structuredClone(result.events) as RetraceEvent[];
  const target = edited.find((e) => e.type === "effect" && e.kind === "fetch");
  assert.ok(target?.type === "effect");
  (target.value as RecordedFetch).request.url = "https://corpus.test/search?q=gamma";

  const report = verifyEvents("read", edited, store);
  const reads = report.checks.find((c) => c.name === "reads");
  assert.equal(reads?.status, "failed");
  assert.match(
    reads?.detail ?? "",
    /holds a response to GET https:\/\/corpus\.test\/search\?q=gamma, which is not what its own slot is a digest of/,
  );
  // Nothing else in the log reaches a fetch, which is the whole reason the
  // check exists: every other check passes this edit.
  assert.equal(report.checks.find((c) => c.name === "requests")?.status, "ok");
  assert.equal(report.checks.find((c) => c.name === "shape")?.status, "ok");
});
