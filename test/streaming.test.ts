import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  defineAgent,
  effectsOf,
  fork,
  MemoryStore,
  MockProvider,
  objectSchema,
  replay,
  run,
  StreamingMockProvider,
  text,
  tool,
  toolUse,
  type Message,
  type ModelRequest,
  type StreamEvent,
} from "../src/index.ts";

/**
 * Streaming is a view of a model call, not an effect of its own. These tests
 * hold two lines: the adapter must reassemble a streamed turn into exactly the
 * message the unstreamed endpoint would have returned, and the loop must
 * journal that assembled message so a streamed run and an unstreamed one leave
 * the same log behind.
 */

function stub(...streams: unknown[][]): {
  provider: AnthropicProvider;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let turn = 0;
  const client = {
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          const events = streams[turn];
          turn += 1;
          if (!events) {
            throw new Error(`stub client has no stream for turn ${turn}: ${streams.length} scripted`);
          }
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    },
  } as never;
  return { provider: new AnthropicProvider({ client }), bodies };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "claude-opus-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  };
}

const start = (usage: Record<string, number> = { input_tokens: 120 }) => ({
  type: "message_start",
  message: { model: "claude-opus-5", usage },
});

const stop = (overrides: Record<string, unknown> = {}) => ({
  type: "message_delta",
  delta: { stop_reason: "end_turn", ...overrides },
  usage: { output_tokens: 42 },
});

test("a streamed call sends the same body as an unstreamed one, plus stream", async () => {
  const { provider, bodies } = stub([start(), stop()]);

  await provider.stream(request({ system: "You are terse.", maxTokens: 4096 }), () => {});

  const body = bodies[0];
  assert.ok(body);
  assert.equal(body["stream"], true);
  assert.equal(body["model"], "claude-opus-5");
  assert.equal(body["max_tokens"], 4096);
  assert.equal(body["system"], "You are terse.");
  assert.equal(body["fallbacks"], "default");
});

test("text fragments arrive as they stream and assemble into one block", async () => {
  const { provider } = stub([
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Wellington " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "has 215,100 " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "people." } },
    { type: "content_block_stop", index: 0 },
    stop(),
  ]);

  const seen: string[] = [];
  const response = await provider.stream(request(), (delta) => {
    if (delta.kind === "text") seen.push(delta.text);
  });

  assert.deepEqual(seen, ["Wellington ", "has 215,100 ", "people."]);
  assert.deepEqual(response.content, [
    { type: "text", text: "Wellington has 215,100 people." },
  ]);
  assert.equal(response.stopReason, "end_turn");
});

test("a thinking signature is reassembled, so raw still echoes back verbatim", async () => {
  const { provider, bodies } = stub(
    [
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Look it up." },
      },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "ErUBCkYIBxgC" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "IkA/signed" } },
      { type: "content_block_stop", index: 0 },
      stop(),
    ],
    [start(), stop()],
  );

  const first = await provider.stream(request(), () => {});

  assert.deepEqual(
    first.raw,
    [{ type: "thinking", thinking: "Look it up.", signature: "ErUBCkYIBxgCIkA/signed" }],
    "the reassembled block must match what the unstreamed endpoint would have returned",
  );

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: first.content, raw: first.raw },
    { role: "user", content: [{ type: "text", text: "go on" }] },
  ];
  await provider.stream(request({ messages }), () => {});

  const sent = bodies[1]?.["messages"] as { role: string; content: unknown }[];
  assert.equal(
    sent[1]?.content,
    first.raw,
    "a signature is only valid on the block that carried it, streamed or not",
  );
});

test("a tool call is announced when it opens and its input arrives parsed", async () => {
  const { provider } = stub([
    start(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "lookup_population", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Wellington"}' } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_2", name: "now", input: {} },
    },
    { type: "content_block_stop", index: 1 },
    stop({ stop_reason: "tool_use" }),
  ]);

  const announced: string[] = [];
  const response = await provider.stream(request(), (delta) => {
    if (delta.kind === "tool_use") announced.push(`${delta.id}:${delta.name}`);
  });

  assert.deepEqual(announced, ["toolu_1:lookup_population", "toolu_2:now"]);
  assert.deepEqual(response.content, [
    { type: "tool_use", id: "toolu_1", name: "lookup_population", input: { city: "Wellington" } },
    // No argument deltas ever arrived, so the block keeps the input it opened with.
    { type: "tool_use", id: "toolu_2", name: "now", input: {} },
  ]);
  assert.equal(response.stopReason, "tool_use");
});

test("usage is merged across the stream, and a refusal keeps its category", async () => {
  const { provider } = stub([
    start({ input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 30 }),
    { type: "ping" },
    {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { category: "cyber" } },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ]);

  const response = await provider.stream(request(), () => {});

  assert.equal(response.stopReason, "refusal");
  assert.equal(response.refusalCategory, "cyber");
  assert.deepEqual(response.usage, {
    inputTokens: 900,
    outputTokens: 7,
    cacheReadTokens: 4000,
    cacheWriteTokens: 30,
  });
});

test("a stream that fails partway fails loudly instead of returning half a turn", async () => {
  const { provider } = stub([
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Welling" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ]);

  await assert.rejects(
    () => provider.stream(request(), () => {}),
    /overloaded_error — Overloaded/,
  );
});

test("a delta for a block that never opened names the block", async () => {
  const { provider } = stub([
    start(),
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "orphan" } },
  ]);

  await assert.rejects(() => provider.stream(request(), () => {}), /content block 2/);
});

/**
 * The same reassembly against the real API, where the fragments are real and
 * the signature has to survive being put back together. Skipped rather than
 * failed without a key, so a checkout with no credentials still goes green.
 */
const noKey = process.env["ANTHROPIC_API_KEY"]
  ? false
  : "ANTHROPIC_API_KEY is not set, so the live Anthropic API cannot be reached";

test("[live] a streamed turn reassembles into one the API accepts back", { skip: noKey }, async (t) => {
  const provider = new AnthropicProvider();
  const base: ModelRequest = {
    model: "claude-opus-5",
    system: "You are terse.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Name three cities in New Zealand." }] },
    ],
    tools: [],
    maxTokens: 2048,
    thinking: "adaptive",
    effort: "low",
  };

  const fragments: string[] = [];
  const first = await provider.stream(base, (delta) => {
    if (delta.kind === "text") fragments.push(delta.text);
  });

  t.diagnostic(`${fragments.length} text fragments, stop_reason=${first.stopReason}`);
  assert.ok(fragments.length > 1, "a real answer arrives in more than one fragment");
  assert.equal(
    fragments.join(""),
    first.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    "the fragments must concatenate to the assembled message",
  );
  assert.ok(first.usage.outputTokens > 0, "message_delta must carry the output token count");

  // Echoing the turn back is the real test: a thinking signature reassembled
  // from deltas is rejected by the API if a single byte moved.
  const second = await provider.stream(
    {
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: first.content, raw: first.raw },
        { role: "user", content: [{ type: "text", text: "Now pick one." }] },
      ],
    },
    () => {},
  );

  assert.ok(second.content.length > 0, "the second turn must produce content");
});

/* The loop. */

const agent = defineAgent({ name: "analyst", model: "claude-opus-5", maxSteps: 6 });

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

const script = [
  { content: [toolUse("t1", "lookup", { term: "retrace" })] },
  { content: [text("A retrace is a rewind you can afford.")] },
];

function collect(): { onStream: (event: StreamEvent) => void; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { events, onStream: (event) => events.push(event) };
}

const said = (events: StreamEvent[]) =>
  events
    .filter((e) => e.delta.kind === "text")
    .map((e) => (e.delta.kind === "text" ? e.delta.text : ""))
    .join("");

test("a streamed run journals the assembled message, not the fragments", async () => {
  const store = new MemoryStore();
  const streamed = collect();
  const provider = new StreamingMockProvider(script);

  const result = await run("What is a retrace?", {
    agent,
    provider,
    tools: [lookup],
    store,
    runId: "streamed",
    onStream: streamed.onStream,
  });

  assert.equal(provider.streamedCalls, 2, "both turns went down the streaming path");
  assert.ok(
    streamed.events.filter((e) => e.delta.kind === "text").length > 1,
    "the final answer should have arrived in more than one fragment",
  );
  assert.equal(said(streamed.events), "A retrace is a rewind you can afford.");
  assert.equal(
    streamed.events.every((e) => !e.replayed),
    true,
  );

  // The same run without streaming: the point is that the logs are identical.
  const plain = await run("What is a retrace?", {
    agent,
    provider: new MockProvider(script),
    tools: [lookup],
    store,
    runId: "plain",
  });

  assert.deepEqual(
    effectsOf(store.read("streamed")).map((e) => ({ kind: e.kind, key: e.key, value: e.value })),
    effectsOf(store.read("plain")).map((e) => ({ kind: e.kind, key: e.key, value: e.value })),
    "a stream must leave no trace of itself in the log",
  );
  assert.equal(result.output, plain.output);
});

test("a replayed step reproduces the turn as fragments without reaching the provider", async () => {
  const store = new MemoryStore();
  await run("What is a retrace?", {
    agent,
    provider: new StreamingMockProvider(script),
    tools: [lookup],
    store,
    runId: "recorded",
    onStream: () => {},
  });

  const replayed = collect();
  // Any model call at all would run this provider out of script.
  const provider = new StreamingMockProvider([]);
  const result = await replay("recorded", {
    provider,
    tools: [lookup],
    store,
    onStream: replayed.onStream,
  });

  assert.equal(provider.calls.length, 0, "a replay must not reach the model, streamed or not");
  assert.equal(said(replayed.events), "A retrace is a rewind you can afford.");
  assert.equal(
    replayed.events.every((e) => e.replayed),
    true,
    "reconstructed fragments must say so",
  );
  assert.deepEqual(
    replayed.events.map((e) => e.delta),
    [
      { kind: "tool_use", id: "t1", name: "lookup" },
      { kind: "text", text: "A retrace is a rewind you can afford." },
    ],
    "one fragment per block: the log holds the turn, not the typing",
  );
  assert.equal(result.output, "A retrace is a rewind you can afford.");
});

test("a provider that cannot stream still delivers the turn to a streaming caller", async () => {
  const listener = collect();
  const provider = new MockProvider(script);

  await run("What is a retrace?", {
    agent,
    provider,
    tools: [lookup],
    store: new MemoryStore(),
    onStream: listener.onStream,
  });

  assert.equal(said(listener.events), "A retrace is a rewind you can afford.");
  assert.equal(
    listener.events.every((e) => !e.replayed),
    true,
    "these turns were live; they just weren't streamed",
  );
});

test("a fork replays fragments below the fork point and streams them above it", async () => {
  const store = new MemoryStore();
  await run("What is a retrace?", {
    agent,
    provider: new MockProvider(script),
    tools: [lookup],
    store,
    runId: "parent",
  });

  const listener = collect();
  const result = await fork("parent", {
    provider: new StreamingMockProvider([{ content: [text("A rewind you can afford.")] }]),
    atStep: 1,
    tools: [lookup],
    store,
    onStream: listener.onStream,
  });

  const byStep = new Map<number, StreamEvent[]>();
  for (const event of listener.events) {
    byStep.set(event.step, [...(byStep.get(event.step) ?? []), event]);
  }

  assert.equal(
    byStep.get(0)?.every((e) => e.replayed),
    true,
    "step 0 came out of the parent's log",
  );
  assert.equal(
    byStep.get(1)?.every((e) => !e.replayed),
    true,
    "step 1 is the one that ran, so its fragments are live",
  );
  assert.ok(
    (byStep.get(1) ?? []).length > 1,
    "the live step should stream in more than one fragment",
  );
  assert.equal(result.output, "A rewind you can afford.");
});
