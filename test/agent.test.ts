import assert from "node:assert/strict";
import test from "node:test";
import {
  defineAgent,
  MemoryStore,
  MockProvider,
  objectSchema,
  run,
  text,
  tool,
  toolUse,
  type RetraceEvent,
} from "../src/index.ts";

const echo = tool({
  name: "echo",
  description: "Echo a string back. Call this when asked to repeat something.",
  inputSchema: objectSchema({ value: { type: "string" } }),
  run: (input: { value: string }) => `echoed:${input.value}`,
});

const agent = defineAgent({ name: "tester", model: "claude-opus-5", maxSteps: 5 });

test("a run with no tool calls completes in one step", async () => {
  const provider = new MockProvider([{ content: [text("done")] }]);
  const result = await run("hi", { agent, provider, store: new MemoryStore() });

  assert.equal(result.status, "completed");
  assert.equal(result.output, "done");
  assert.equal(result.totals.steps, 1);
  assert.equal(result.totals.toolCalls, 0);
});

test("tool calls are executed and fed back to the model", async () => {
  const provider = new MockProvider([
    { content: [toolUse("t1", "echo", { value: "ping" })] },
    { content: [text("the tool said pong")] },
  ]);

  const result = await run("echo ping", {
    agent,
    provider,
    tools: [echo],
    store: new MemoryStore(),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.totals.toolCalls, 1);
  const secondRequest = provider.calls[1];
  assert.ok(secondRequest);
  const toolResultTurn = secondRequest.messages.at(-1);
  assert.equal(toolResultTurn?.role, "user");
  assert.deepEqual(toolResultTurn?.content, [
    { type: "tool_result", toolUseId: "t1", content: "echoed:ping" },
  ]);
});

test("a throwing tool is reported to the model, not to the caller", async () => {
  const boom = tool({
    name: "boom",
    description: "Always fails. Call this when testing error handling.",
    inputSchema: objectSchema({}),
    run: () => {
      throw new Error("disk on fire");
    },
  });
  const provider = new MockProvider([
    { content: [toolUse("t1", "boom", {})] },
    { content: [text("recovered")] },
  ]);

  const result = await run("go", { agent, provider, tools: [boom], store: new MemoryStore() });

  assert.equal(result.status, "completed");
  assert.equal(result.output, "recovered");
  const effect = result.events.find((e) => e.type === "effect" && e.kind === "tool");
  assert.ok(effect && effect.type === "effect");
  assert.deepEqual(effect.value, { content: "disk on fire", isError: true });
});

test("calling an unregistered tool surfaces the available names", async () => {
  const provider = new MockProvider([
    { content: [toolUse("t1", "ghost", {})] },
    { content: [text("ok")] },
  ]);

  const result = await run("go", { agent, provider, tools: [echo], store: new MemoryStore() });

  const effect = result.events.find((e) => e.type === "effect" && e.kind === "tool");
  assert.ok(effect && effect.type === "effect");
  const value = effect.value as { content: string; isError: boolean };
  assert.equal(value.isError, true);
  assert.match(value.content, /"ghost", which is not registered/);
  assert.match(value.content, /echo/);
});

test("a refusal ends the run rather than looping", async () => {
  const provider = new MockProvider([
    { content: [text("")], stopReason: "refusal" },
    { content: [text("unreachable")] },
  ]);

  const result = await run("go", { agent, provider, store: new MemoryStore() });

  assert.equal(result.status, "refused");
  assert.equal(provider.callCount, 1);
});

test("hitting maxSteps is a reported outcome, not an exception", async () => {
  const looping = defineAgent({ name: "looper", maxSteps: 2 });
  const provider = new MockProvider([
    { content: [toolUse("a", "echo", { value: "1" })] },
    { content: [toolUse("b", "echo", { value: "2" })] },
  ]);

  const result = await run("loop", {
    agent: looping,
    provider,
    tools: [echo],
    store: new MemoryStore(),
  });

  assert.equal(result.status, "max_steps");
  assert.equal(result.totals.steps, 2);
});

test("the event log is complete, ordered, and ends with run.finished", async () => {
  const store = new MemoryStore();
  const provider = new MockProvider([
    { content: [toolUse("t1", "echo", { value: "x" })] },
    { content: [text("done")] },
  ]);

  const result = await run("go", { agent, provider, tools: [echo], store });
  const persisted: RetraceEvent[] = store.read(result.runId);

  assert.deepEqual(
    persisted.map((e) => e.seq),
    persisted.map((_, i) => i),
    "seq must be dense and ordered",
  );
  assert.equal(persisted[0]?.type, "run.started");
  assert.equal(persisted.at(-1)?.type, "run.finished");
  assert.deepEqual(persisted, result.events);
});
