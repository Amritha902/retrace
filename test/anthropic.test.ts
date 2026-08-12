import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  objectSchema,
  type Message,
  type ModelRequest,
  type ToolSchema,
} from "../src/index.ts";

/**
 * The provider is the one place where Retrace's own types meet the SDK's, so the
 * tests below drive it through a stub client: they assert the request body the
 * adapter builds and the normalization it applies coming back, with no network.
 * The live test at the bottom is the same contract against the real API, and
 * skips itself when there is no key.
 */

function stub(...responses: unknown[]): {
  provider: AnthropicProvider;
  bodies: Record<string, unknown>[];
  fallbacksOff: AnthropicProvider;
} {
  const bodies: Record<string, unknown>[] = [];
  let turn = 0;
  const client = {
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          const response = responses[turn];
          turn += 1;
          if (!response) {
            throw new Error(
              `stub client has no response for turn ${turn}: ${responses.length} scripted`,
            );
          }
          return response;
        },
      },
    },
  } as never;
  return {
    provider: new AnthropicProvider({ client }),
    fallbacksOff: new AnthropicProvider({ client, fallbacks: false }),
    bodies,
  };
}

/** A response with just enough shape to be a valid SDK message. */
function sdkMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-opus-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
    ...overrides,
  };
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

const searchSchema: ToolSchema = {
  name: "search",
  description: "Search the corpus. Call this whenever the answer depends on a fact you were not given.",
  inputSchema: objectSchema({ query: { type: "string" } }),
};

test("the request carries model, tokens, system, and tools in the API's own shape", async () => {
  const { provider, bodies } = stub(sdkMessage());

  await provider.complete(
    request({ system: "You are terse.", tools: [searchSchema], maxTokens: 4096 }),
  );

  const body = bodies[0];
  assert.ok(body);
  assert.equal(body["model"], "claude-opus-5");
  assert.equal(body["max_tokens"], 4096);
  assert.equal(body["system"], "You are terse.");
  assert.deepEqual(body["tools"], [
    {
      name: "search",
      description: searchSchema.description,
      input_schema: searchSchema.inputSchema,
    },
  ]);
  assert.deepEqual(body["messages"], [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("system and tools are omitted rather than sent empty", async () => {
  const { provider, bodies } = stub(sdkMessage());

  await provider.complete(request());

  const body = bodies[0];
  assert.ok(body);
  assert.equal("system" in body, false);
  assert.equal("tools" in body, false);
  assert.equal("thinking" in body, false);
  assert.equal("output_config" in body, false);
});

test("thinking and effort map onto adaptive thinking and output_config", async () => {
  const { provider, bodies } = stub(sdkMessage(), sdkMessage());

  await provider.complete(request({ thinking: "adaptive", effort: "low" }));
  await provider.complete(request({ thinking: "disabled" }));

  assert.deepEqual(bodies[0]?.["thinking"], { type: "adaptive" });
  assert.deepEqual(bodies[0]?.["output_config"], { effort: "low" });
  assert.deepEqual(bodies[1]?.["thinking"], { type: "disabled" });
});

test("fallbacks are on by default and carry the beta the parameter needs", async () => {
  const { provider, fallbacksOff, bodies } = stub(sdkMessage(), sdkMessage());

  await provider.complete(request());
  await fallbacksOff.complete(request());

  assert.equal(bodies[0]?.["fallbacks"], "default");
  assert.deepEqual(bodies[0]?.["betas"], ["server-side-fallback-2026-07-01"]);
  assert.equal("fallbacks" in (bodies[1] ?? {}), false);
  assert.equal("betas" in (bodies[1] ?? {}), false);
});

test("content blocks are normalized and unknown block types are dropped", async () => {
  const blocks = [
    { type: "thinking", thinking: "", signature: "sig-abc" },
    { type: "text", text: "hello" },
    { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
  ];
  const { provider } = stub(sdkMessage({ content: blocks }));

  const response = await provider.complete(request());

  assert.deepEqual(response.content, [
    { type: "thinking", thinking: "" },
    { type: "text", text: "hello" },
    { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
  ]);
  assert.equal(response.raw, blocks, "raw must be the provider's blocks, untouched");
});

test("usage, stop reason, and model fall back to sane values when the API omits them", async () => {
  const { provider } = stub({ content: [] });

  const response = await provider.complete(request({ model: "claude-opus-5" }));

  assert.equal(response.model, "claude-opus-5");
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(response.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(response.refusalCategory, null);
});

test("cache tokens and a refusal category survive the translation", async () => {
  const { provider } = stub(
    sdkMessage({
      model: "claude-opus-4-8",
      content: [],
      stop_reason: "refusal",
      stop_details: { category: "cyber" },
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 40,
      },
    }),
  );

  const response = await provider.complete(request());

  assert.equal(response.model, "claude-opus-4-8", "a fallback answer names the model that served it");
  assert.equal(response.stopReason, "refusal");
  assert.equal(response.refusalCategory, "cyber");
  assert.deepEqual(response.usage, {
    inputTokens: 100,
    outputTokens: 5,
    cacheReadTokens: 900,
    cacheWriteTokens: 40,
  });
});

test("a thinking block round-trips byte-for-byte through raw", async () => {
  const blocks = [
    { type: "thinking", thinking: "", signature: "ErUBCkYIBxgCIkA/signed" },
    { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
  ];
  const { provider, bodies } = stub(sdkMessage({ content: blocks }), sdkMessage());

  const first = await provider.complete(request({ tools: [searchSchema] }));
  const secondTurn: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: first.content, raw: first.raw },
    { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "3 results" }] },
  ];
  await provider.complete(request({ tools: [searchSchema], messages: secondTurn }));

  const sent = bodies[1]?.["messages"] as { role: string; content: unknown }[];
  assert.equal(sent[1]?.role, "assistant");
  assert.equal(
    sent[1]?.content,
    blocks,
    "the signature is only valid on the original block, so it must go back unmodified",
  );
});

test("an assistant turn without raw drops thinking and rebuilds the rest", async () => {
  const { provider, bodies } = stub(sdkMessage());
  const messages: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "unsigned, cannot be echoed" },
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
      ],
    },
    { role: "user", content: [{ type: "text", text: "go on" }] },
  ];

  await provider.complete(request({ messages }));

  const sent = bodies[0]?.["messages"] as { role: string; content: unknown }[];
  assert.deepEqual(sent[0], {
    role: "assistant",
    content: [
      { type: "text", text: "let me look" },
      { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
    ],
  });
});

test("tool results translate, and only failures are flagged as errors", async () => {
  const { provider, bodies } = stub(sdkMessage());
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "toolu_1", content: "3 results" },
        { type: "tool_result", toolUseId: "toolu_2", content: "disk on fire", isError: true },
        { type: "text", text: "what now?" },
      ],
    },
  ];

  await provider.complete(request({ messages }));

  const sent = bodies[0]?.["messages"] as { role: string; content: unknown }[];
  assert.deepEqual(sent[0]?.content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "3 results" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "disk on fire", is_error: true },
    { type: "text", text: "what now?" },
  ]);
});

/**
 * The same contract against the real API. Skipped rather than failed without a
 * key, so a checkout with no credentials still goes green.
 */
const noKey = process.env["ANTHROPIC_API_KEY"]
  ? false
  : "ANTHROPIC_API_KEY is not set, so the live Anthropic API cannot be reached";

test("[live] the API accepts the request and its blocks round-trip", { skip: noKey }, async (t) => {
  const provider = new AnthropicProvider();
  const base: ModelRequest = {
    model: "claude-opus-5",
    system: "You are terse. Use the tool when asked about a city.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "What is the population of Wellington, New Zealand?" }],
      },
    ],
    tools: [
      {
        name: "lookup_population",
        description:
          "Look up a city's current population. Call this whenever you are asked how many people live somewhere.",
        inputSchema: objectSchema({ city: { type: "string" } }),
      },
    ],
    maxTokens: 2048,
    thinking: "adaptive",
    effort: "low",
  };

  const first = await provider.complete(base);

  assert.ok(first.model.startsWith("claude"), `unexpected model: ${first.model}`);
  assert.ok(first.usage.inputTokens > 0, "the API must report input tokens");
  assert.ok(Array.isArray(first.raw), "raw must hold the provider's own blocks");
  for (const block of first.content) {
    assert.ok(
      block.type === "text" || block.type === "thinking" || block.type === "tool_use",
      `unnormalized block reached the log: ${block.type}`,
    );
  }

  const call = first.content.find((b) => b.type === "tool_use");
  t.diagnostic(
    `stop_reason=${first.stopReason} blocks=${first.content.map((b) => b.type).join(",")}`,
  );

  // Echoing the turn back is the real test: thinking blocks are signed, and the
  // API rejects one that was edited or rebuilt. A second turn that succeeds is
  // proof the `raw` passthrough kept them intact.
  const second = await provider.complete({
    ...base,
    messages: [
      ...base.messages,
      { role: "assistant", content: first.content, raw: first.raw },
      call
        ? { role: "user", content: [{ type: "tool_result", toolUseId: call.id, content: "215,100" }] }
        : { role: "user", content: [{ type: "text", text: "Thanks." }] },
    ],
  });

  assert.ok(second.content.length > 0, "the second turn must produce content");
  assert.ok(second.usage.outputTokens > 0);
});
