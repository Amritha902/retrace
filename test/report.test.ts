import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  fork,
  MockProvider,
  objectSchema,
  renderReport,
  resume,
  run,
  RunStore,
  summarize,
  text,
  tool,
  toolUse,
  type RetraceEvent,
} from "../src/index.ts";

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are a researcher.",
  maxSteps: 6,
});

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

const script = () => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [text("alpha, explained")] },
];

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Record a two-step run and hand back its log. */
async function record(dir: string, runId = "baseline"): Promise<RetraceEvent[]> {
  const result = await run("explain alpha", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    store: new RunStore(dir),
    runId,
  });
  return result.events;
}

function render(events: RetraceEvent[], runId = "baseline"): string {
  return renderReport(summarize(runId, events), events);
}

function capture(): Io & { text(): string; errors(): string } {
  let out = "";
  let err = "";
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    text: () => out.replace(/\x1b\[[0-9;]*m/g, ""),
    errors: () => err.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

/** The same run, with the model throwing on the second turn. */
async function recordFailure(dir: string, runId = "died"): Promise<RetraceEvent[]> {
  const provider = new MockProvider(script());
  const overloaded = Object.assign(new Error("the model is overloaded, try again"), {
    name: "APIOverloadedError",
  });
  const result = await run("explain alpha", {
    agent,
    provider: {
      name: "mock",
      complete: async (request) => {
        if (provider.callCount === 1) throw overloaded;
        return provider.complete(request);
      },
    },
    tools: [lookup],
    store: new RunStore(dir),
    runId,
  });
  return result.events;
}

test("the report is one file: no scripts, no external references", async (t) => {
  const html = render(await record(tempDir(t)));

  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i, "a trace viewer that needs JS is not self-contained");
  assert.doesNotMatch(html, /https?:\/\//, "nothing may be fetched from the network");
  assert.doesNotMatch(html, /<(img|link|iframe)\b/i);
  assert.doesNotMatch(html, /@import|url\(/, "no external stylesheet or font");
});

test("the report carries the run's identity, input and outcome", async (t) => {
  const html = render(await record(tempDir(t)));

  assert.match(html, /<title>retrace · baseline<\/title>/);
  assert.match(html, /<h1>baseline<\/h1>/);
  assert.match(html, /claude-opus-5/);
  assert.match(html, /via mock/);
  assert.match(html, /explain alpha/);
  assert.match(html, /alpha, explained/, "the final answer is on the page");
  assert.match(html, /class="status good">completed</);
});

test("every effect in the log reaches the page, keyed the way the log keys it", async (t) => {
  const html = render(await record(tempDir(t)));

  assert.match(html, /step:0<\/span>/);
  assert.match(html, /step:0#0:lookup/);
  assert.match(html, /step:1<\/span>/);
  assert.match(html, /definition of alpha/, "the recorded tool result is shown");
  assert.match(html, /&quot;term&quot;: &quot;alpha&quot;/, "so is the input it was called with");
});

test("a fork's report tells its replayed prefix apart from its live steps", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("shorter")] }]),
    atStep: 1,
    tools: [lookup],
    agent: { system: "Answer in one word." },
    store: new RunStore(dir),
    runId: "forked",
  });

  const html = render(forked.events, "forked");

  assert.match(html, /forked from <span class="mono">baseline<\/span> at step 1/);
  assert.match(
    html,
    /badge replayed">replayed<\/span><span class="badge stale"[^>]*>stale system<\/span><span class="kind">model/,
    "the replayed model call is stale, and the badge names the prompt as what moved",
  );
  assert.match(html, /badge replayed">replayed<\/span><span class="kind">tool/);
  assert.match(html, /badge live">live<\/span><span class="kind">model/);
  assert.match(html, /2 of 3 effects were served from a log/, "the lede counts the saving");
  assert.match(html, /replayed, not billed/);
});

test("a tool answered a different call gets its own badge and its own explanation", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const forked = await fork("baseline", {
    provider: new MockProvider([{ content: [text("shorter")] }]),
    atStep: 1,
    tools: [lookup],
    overrides: {
      "step:0": {
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: { term: "omega" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
    store: new RunStore(dir),
    runId: "rerouted",
  });

  const html = render(forked.events, "rerouted");

  assert.match(
    html,
    /badge stale"[^>]*>stale input<\/span><span class="kind">tool/,
    "the tool call is stale, and the badge names its input as what moved",
  );
  // Its own sentence rather than being counted in with the model calls: a
  // request the run no longer builds and a tool handed somebody else's answer
  // are different things to have gone wrong.
  assert.match(html, /1 of them was given the answer to a different call/);
  assert.doesNotMatch(html, /of them answer a request this run no longer builds/);
});

test("a resumed run's report names the parent and the state it stopped in", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await record(dir);
  for (const event of store.read("baseline")) {
    if (event.type === "run.finished") break;
    if (event.type === "effect" && event.index >= 1) break;
    store.append("killed", event);
  }

  const resumed = await resume("killed", {
    provider: new MockProvider([{ content: [text("alpha, explained")] }]),
    tools: [lookup],
    store,
    runId: "resumed",
  });

  const html = render(resumed.events, "resumed");
  assert.match(
    html,
    /resumed from <span class="mono">killed<\/span>, which stopped running after 1 effect<\/p>/,
  );
});

test("the call a run died on is a card of its own, not a hole in the page", async (t) => {
  const html = render(await recordFailure(tempDir(t)), "died");

  assert.match(html, /class="status bad">failed</);
  assert.match(html, /step:1<\/span>/, "the effect that threw is on the page");
  assert.match(html, /APIOverloadedError/);
  assert.match(html, /the model is overloaded, try again/);
  assert.match(html, /A replay of this log stops here too/);
});

test("a report of a run with nothing replayed says so plainly", async (t) => {
  const html = render(await record(tempDir(t)));

  assert.match(html, /All 3 effects ran live\./);
  assert.doesNotMatch(html, /badge replayed/);
});

test("content that would otherwise be markup is escaped", async (t) => {
  const dir = tempDir(t);
  const hostile = tool({
    name: "fetch_page",
    description: "Fetch a page. Call this to read a URL's contents.",
    inputSchema: objectSchema({ url: { type: "string" } }),
    run: () => `<script>alert("pwned")</script> & <img src=x onerror=1>`,
  });
  const result = await run("fetch it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "fetch_page", { url: "<b>x</b>" })] },
      { content: [text("done <em>ok</em>")] },
    ]),
    tools: [hostile],
    store: new RunStore(dir),
    runId: "hostile",
  });

  const html = render(result.events, "hostile");

  assert.match(html, /&lt;script&gt;alert\(&quot;pwned&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;em&gt;ok&lt;\/em&gt;/);
  assert.match(html, /&amp;/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
});

test("what a tool read from the journal is shown inside that tool's card", async (t) => {
  const dir = tempDir(t);
  const stamp = tool({
    name: "stamp",
    description: "File a record. Call this to record that something happened.",
    inputSchema: objectSchema({}),
    run: async (_input: unknown, ctx) => `${await ctx.now()} ${await ctx.uuid()}`,
  });
  const result = await run("file it", {
    agent,
    provider: new MockProvider([
      { content: [toolUse("t1", "stamp", {})] },
      { content: [text("filed")] },
    ]),
    tools: [stamp],
    store: new RunStore(dir),
    runId: "stamped",
  });

  const html = render(result.events, "stamped");

  const reads = html.slice(html.indexOf(`<ul class="reads">`), html.indexOf("</ul>"));
  assert.match(reads, /<span class="kind">clock<\/span><span class="mono dim">clock:0<\/span>/);
  assert.match(reads, /<span class="kind">uuid<\/span><span class="mono dim">uuid:0<\/span>/);
  // The raw epoch is what replays; the readable form beside it is for the human.
  assert.match(reads, /\d{13}\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/);
  assert.doesNotMatch(
    html,
    /step:0#0:stamp\/clock:0/,
    "a read belongs to its tool call, not to a row of its own",
  );
});

test("a tool the model asked for but never got to run is not dropped from the page", async (t) => {
  const dir = tempDir(t);
  const result = await run("explain alpha", {
    agent,
    provider: new MockProvider(script()),
    tools: [lookup],
    budget: { toolCalls: 0 },
    store: new RunStore(dir),
    runId: "cutoff",
  });
  assert.equal(result.status, "budget_exceeded");

  const html = render(result.events, "cutoff");

  assert.match(html, /badge unrun">not run<\/span>/);
  assert.match(html, /The model requested this call; the run ended before it was made\./);
  assert.match(html, /class="status warn">budget exceeded</);
  assert.match(html, /class="error">/, "the reason the run stopped is on the page");
});

test("a log that stops mid-run renders what it has, and says the totals are partial", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const store = new RunStore(dir);
  for (const event of store.read("baseline")) {
    if (event.type === "run.finished") continue;
    store.append("truncated", event);
  }

  const html = render(store.read("truncated"), "truncated");

  assert.match(html, /class="status idle">running</);
  assert.match(html, /no finish event/);
  assert.match(html, /step:0#0:lookup/, "the truthful prefix is still a timeline");
});

test("the same log renders the same page, byte for byte", async (t) => {
  const events = await record(tempDir(t));

  assert.equal(render(events), render(events), "a report must not depend on when it was made");
});

test("the page defines both themes and never leaves a colour undefined", async (t) => {
  const html = render(await record(tempDir(t)));

  const light = tokensIn(html.match(/:root\{([^}]*)\}/)?.[1]);
  const dark = tokensIn(html.match(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)?.[1]);

  assert.ok(dark.size > 0, "the page has to be readable in a dark browser");
  for (const used of new Set([...html.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1] as string))) {
    assert.ok(light.has(used), `${used} is used but never defined in the light palette`);
  }
  for (const name of dark) {
    assert.ok(light.has(name), `${name} exists only in dark, so light falls back to nothing`);
  }
});

function tokensIn(block: string | undefined): Set<string> {
  return new Set([...(block ?? "").matchAll(/(--[a-z-]+):/g)].map((m) => m[1] as string));
}

test("report writes a file next to the run, and says what it wrote", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const out = join(dir, "trace.html");
  const io = capture();

  const code = await main(["report", "baseline", "--dir", dir, "-o", out], io);

  assert.equal(code, 0, io.errors());
  assert.match(readFileSync(out, "utf8"), /<h1>baseline<\/h1>/);
  assert.match(io.text(), /baseline → .*trace\.html/);
  assert.match(io.text(), /2 steps · 3 effects/);
  assert.match(io.text(), /no external assets/);
});

test("report writes to stdout with -o -, so it can be piped", async (t) => {
  const dir = tempDir(t);
  await record(dir);
  const io = capture();

  const code = await main(["report", "baseline", "--dir", dir, "-o", "-"], io);

  assert.equal(code, 0, io.errors());
  assert.match(io.text(), /^<!doctype html>/);
  assert.doesNotMatch(io.text(), /wrote/);
});

test("report says what it needs when it is given no run", async (t) => {
  const dir = tempDir(t);
  const missing = capture();
  assert.equal(await main(["report", "--dir", dir], missing), 1);
  assert.match(missing.errors(), /report needs a run id/);

  const nonesuch = capture();
  assert.equal(await main(["report", "nonesuch", "--dir", dir], nonesuch), 1);
  assert.match(nonesuch.errors(), /no run "nonesuch"/);
});
