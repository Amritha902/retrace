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
  type ContentBlock,
  type ModelRequest,
  type ModelResponse,
  type RetraceEvent,
  type ScriptedTurn,
  type Tool,
  type ToolContext,
} from "../src/index.ts";

/**
 * The one claim the whole runtime rests on — "replay is the same loop with a
 * non-empty journal, so it cannot drift" — is worth more than a single
 * hand-written example. The rest of the suite pins particular shapes; this file
 * generates a space of them and holds every one to the same invariant.
 *
 * The generator is seeded rather than random, so a failure names a run you can
 * reproduce by pasting its seed back in. It uses a small PRNG of its own rather
 * than `Math.random`, so the numbers do not move between machines or runs, which
 * is the same reason the runtime it is testing exists.
 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A pool of tools that between them touch every read the journal covers: a pure
 * function, the clock/uuid/random effects, and a declared `ctx.read`. A replay
 * that reproduces a run using these has reproduced values that were recorded
 * from the wall clock and a real RNG — the ones a second execution could never
 * match, and the reason the log has to hold them at all.
 *
 * Each factory keeps a live-execution counter, so a replay can be proven not to
 * have run any of them.
 */
function makeTools(): { tools: Tool[]; ran: () => number } {
  let ran = 0;
  const tools = [
    tool({
      name: "lookup",
      description: "Look a term up. A pure function of its input.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => {
        ran++;
        return `definition of ${input.term}`;
      },
    }),
    tool({
      name: "stamp",
      description: "File a record with the current time, a fresh id and a die roll.",
      inputSchema: objectSchema({ label: { type: "string" } }),
      run: async (input: { label: string }, ctx: ToolContext) => {
        ran++;
        const at = await ctx.now();
        const id = await ctx.uuid();
        const roll = await ctx.random();
        return `${input.label} at ${at} as ${id} roll ${roll}`;
      },
    }),
    tool({
      name: "consult",
      description: "Ask the knowledge base a question through the journal's read boundary.",
      inputSchema: objectSchema({ topic: { type: "string" } }),
      run: async (input: { topic: string }, ctx: ToolContext) => {
        ran++;
        return await ctx.read("kb", { topic: input.topic }, () => `kb says: ${input.topic}`);
      },
    }),
  ];
  return { tools, ran: () => ran };
}

const TOOL_NAMES = ["lookup", "stamp", "consult"] as const;
const INPUT_KEY = { lookup: "term", stamp: "label", consult: "topic" } as const;

interface GeneratedRun {
  seed: number;
  input: string;
  script: ScriptedTurn[];
  /** The 0-based live model turn that throws, or -1 for a run that completes. */
  failOn: number;
}

/**
 * Build one run: some number of tool-calling turns, then a written answer.
 * Non-final turns always carry at least one tool call so the loop advances;
 * thinking and text blocks are sprinkled in as extra content, never as the only
 * content, so the stop reason stays what the shape needs.
 */
function generate(seed: number): GeneratedRun {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const toolTurns = Math.floor(r() * 4); // 0..3 tool-calling turns
  const script: ScriptedTurn[] = [];
  let callId = 0;

  for (let turn = 0; turn < toolTurns; turn++) {
    const content: ContentBlock[] = [];
    if (r() < 0.3) content.push({ type: "thinking", thinking: `weighing turn ${turn}` });
    if (r() < 0.2) content.push(text(`about to look into turn ${turn}`));
    const calls = 1 + Math.floor(r() * 3); // 1..3 tool calls in this turn
    for (let c = 0; c < calls; c++) {
      const name = pick(TOOL_NAMES);
      const arg = `${name}-${turn}-${c}`;
      content.push(toolUse(`c${callId++}`, name, { [INPUT_KEY[name]]: arg }));
    }
    script.push({
      content,
      usage: {
        inputTokens: 1000 + Math.floor(r() * 40000),
        outputTokens: 50 + Math.floor(r() * 1000),
        cacheReadTokens: Math.floor(r() * 2000),
      },
    });
  }

  const answer: ContentBlock[] = [];
  if (r() < 0.3) answer.push({ type: "thinking", thinking: "composing the answer" });
  answer.push(text(`answer for seed ${seed}`));
  script.push({ content: answer });

  // A quarter of the runs die on the model: a throw somewhere in the live turns.
  const failOn = r() < 0.25 ? Math.floor(r() * script.length) : -1;

  return { seed, input: `run ${seed}`, script, failOn };
}

const agent = defineAgent({ name: "fuzzed", model: "claude-opus-5", maxSteps: 12 });

/** A provider that reads a script but throws on one chosen live call. */
class FailingProvider extends MockProvider {
  private live = 0;
  private readonly failOn: number;
  constructor(script: ScriptedTurn[], failOn: number) {
    super(script);
    this.failOn = failOn;
  }
  override async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.live++ === this.failOn) throw new Error(`model overloaded (seed run)`);
    return super.complete(request);
  }
}

/** The comparable core of an effect: everything a replay must reproduce. */
function shape(events: readonly RetraceEvent[]) {
  return effectsOf(events).map((e) => ({
    index: e.index,
    kind: e.kind,
    key: e.key,
    value: e.value,
    failed: e.failed,
  }));
}

test("a replay reproduces every generated run's log and executes nothing", async () => {
  // Enough shapes to cover the branches — thinking blocks, multi-call turns,
  // clock/uuid/random/read effects, and model throws — many times over.
  const RUNS = 60;
  for (let i = 0; i < RUNS; i++) {
    const seed = 0x51ed + i * 0x9e37;
    const spec = generate(seed);
    const store = new MemoryStore();

    const baseTools = makeTools();
    const baseProvider =
      spec.failOn === -1
        ? new MockProvider(spec.script)
        : new FailingProvider(spec.script, spec.failOn);
    const baseline = await run(spec.input, {
      agent,
      provider: baseProvider,
      tools: baseTools.tools,
      store,
      runId: `base-${i}`,
    });

    assert.equal(
      baseline.status,
      spec.failOn === -1 ? "completed" : "failed",
      `seed ${seed}: baseline ended ${baseline.status}`,
    );

    // Replay with a provider that throws on any call and fresh, zeroed tools.
    const replayTools = makeTools();
    const replayProvider = new MockProvider([]);
    const replayed = await replay(`base-${i}`, {
      provider: replayProvider,
      tools: replayTools.tools,
      store,
      runId: `replay-${i}`,
    });

    assert.equal(replayProvider.callCount, 0, `seed ${seed}: replay called the model`);
    assert.equal(replayTools.ran(), 0, `seed ${seed}: replay re-ran a tool`);
    assert.equal(replayed.status, baseline.status, `seed ${seed}: status drifted`);
    assert.equal(replayed.output, baseline.output, `seed ${seed}: output drifted`);
    assert.deepEqual(shape(replayed.events), shape(baseline.events), `seed ${seed}: effects drifted`);

    // The other half of the claim: what came out of the log took no time and
    // cost nothing.
    for (const e of effectsOf(replayed.events)) {
      assert.equal(e.replayed, true, `seed ${seed}: ${e.kind}:${e.key} was not served from the log`);
      assert.equal(e.durationMs, 0, `seed ${seed}: a replayed effect claims to have taken time`);
    }
    assert.equal(replayed.totals.billedUsd, 0, `seed ${seed}: a replay was billed`);
    assert.equal(
      replayed.totals.savedUsd,
      baseline.totals.costUsd,
      `seed ${seed}: the saving is not the whole list price`,
    );
  }
});

test("forking a pure run at every step reproduces the whole log", async () => {
  // The fork guarantee, not the replay one: the prefix comes from the log and
  // the tail goes live, and because these runs are pure functions of their
  // inputs the live tail reproduces what the recording executed — so the fork's
  // log should equal the parent's at every fork point. Only `lookup` is used,
  // since a tail that read the clock would (correctly) record fresh values.
  const RUNS = 20;
  for (let i = 0; i < RUNS; i++) {
    const seed = 0xf00d + i * 0x2545;
    const r = prng(seed);
    const steps = 1 + Math.floor(r() * 4); // 1..4 lookup turns
    const script: ScriptedTurn[] = [];
    for (let s = 0; s < steps; s++) {
      script.push({ content: [toolUse(`t${s}`, "lookup", { term: `term-${s}` })] });
    }
    script.push({ content: [text(`done ${seed}`)] });

    const store = new MemoryStore();
    const baseline = await run(`fork run ${seed}`, {
      agent,
      provider: new MockProvider(script),
      tools: makeTools().tools,
      store,
      runId: `pure-${i}`,
    });
    assert.equal(baseline.status, "completed");

    const want = shape(baseline.events);
    // Fork at 0 (all live) through steps+1 (all replayed) — every cut.
    for (let at = 0; at <= script.length; at++) {
      const forked = await fork(`pure-${i}`, {
        atStep: at,
        // A positional provider: turn 0 of the fork is the parent's turn `at`.
        provider: new MockProvider(script.slice(at)),
        tools: makeTools().tools,
        store,
        runId: `pure-${i}-at-${at}`,
      });
      assert.equal(forked.status, "completed", `seed ${seed} at ${at}: status`);
      assert.equal(forked.output, baseline.output, `seed ${seed} at ${at}: output`);
      assert.deepEqual(shape(forked.events), want, `seed ${seed} at ${at}: effects`);
    }
  }
});
