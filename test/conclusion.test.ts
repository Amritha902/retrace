import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, type Io } from "../src/cli.ts";
import {
  defineAgent,
  MemoryStore,
  MockProvider,
  objectSchema,
  run,
  RunStore,
  text,
  tool,
  toolUse,
  verifyEvents,
  verifyRun,
  type Check,
  type ModelRequest,
  type ModelResponse,
  type RetraceEvent,
  type ScriptedTurn,
  type VerifyReport,
} from "../src/index.ts";

/**
 * `run.finished` is the last line of a log and the first thing a person reads.
 * Every other check here walks the effects and stops; these hold the answer and
 * the status that closing line reports to the run the effects describe.
 */

const agent = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 6 });

const lookup = tool({
  name: "lookup",
  description: "Look a term up. Call this when you need a fact you don't have.",
  inputSchema: objectSchema({ term: { type: "string" } }),
  run: (input: { term: string }) => `definition of ${input.term}`,
});

/** Two tool calls, then an answer. */
const script = (): ScriptedTurn[] => [
  { content: [toolUse("t1", "lookup", { term: "alpha" })] },
  { content: [toolUse("t2", "lookup", { term: "beta" })] },
  { content: [text("alpha and beta, explained")] },
];

function conclusionOf(report: VerifyReport): Check {
  const found = report.checks.find((c) => c.name === "conclusion");
  assert.ok(found, "the report has no conclusion check");
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

async function record(
  store: RunStore,
  options: { turns?: ScriptedTurn[]; runId?: string; agentSpec?: typeof agent; budget?: object } = {},
) {
  return run("explain alpha and beta", {
    agent: options.agentSpec ?? agent,
    provider: new MockProvider(options.turns ?? script()),
    tools: [lookup],
    store,
    runId: options.runId ?? "baseline",
    ...(options.budget ? { budget: options.budget } : {}),
  });
}

test("a completed run's answer is the response its log ends on", async () => {
  const store = new MemoryStore();
  await record(store);

  const check = conclusionOf(verifyRun("baseline", store));

  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /completed on "alpha and beta, explained"/);
});

test("an answer edited into the log is not the one the log's last response gives", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.output = "alpha and beta, and a third thing";
    },
  );

  const report = verifyEvents("baseline", doctored, store);
  const check = conclusionOf(report);

  assert.equal(report.ok, false);
  assert.equal(check.status, "failed");
  assert.match(check.detail, /reports its answer as "alpha and beta, and a third thing"/);
  assert.match(check.detail, /the text of the response it ends on is "alpha and beta, explained"/);
});

test("every other check passes the log whose answer was rewritten", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.output = "something else entirely";
    },
  );

  // The point of the check: the effects, the messages, the digests and the
  // charges are all untouched, so the log the reader is shown disagrees with the
  // run only in the one line nothing else reads.
  for (const check of verifyEvents("baseline", doctored, store).checks) {
    if (check.name === "conclusion") continue;
    assert.notEqual(check.status, "failed", `${check.name}: ${check.detail}`);
  }
});

test("a log cannot report completing on a turn that asked for tools", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  // The final answer dropped, as a log truncated to its second step would be:
  // the last response asks for a lookup, and the run claims it finished there.
  const trimmed = structuredClone(result.events).filter(
    (e) => !(e.type === "effect" && e.key === "step:2"),
  ) as RetraceEvent[];

  const check = conclusionOf(verifyEvents("baseline", trimmed, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /reports completing at step:1, where the model asked for 1 tool call/);
});

test("a completed run carrying an error is a log saying two things at once", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.error = "the model is overloaded, try again";
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /reports completing and carries the error/);
});

test("a refusal is held to the response that refused, and reports no answer", async () => {
  const store = new MemoryStore();
  const result = await record(store, {
    turns: [{ content: [text("I can't help with that.")], stopReason: "refusal" }],
  });

  assert.equal(result.status, "refused");
  assert.equal(result.output, "");
  const check = conclusionOf(verifyRun("baseline", store));
  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /refused, with no answer/);
});

test("a refusal given the answer it never gave is caught", async () => {
  const store = new MemoryStore();
  const result = await record(store, {
    turns: [{ content: [text("I can't help with that.")], stopReason: "refusal" }],
  });

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.output = "here is how to do it";
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /a declined request produces no answer/);
});

test("a refusal whose reason was rewritten no longer matches the response", async () => {
  const store = new MemoryStore();
  const result = await record(store, {
    turns: [{ content: [text("I can't help with that.")], stopReason: "refusal" }],
  });

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.error = "the model declined this request (violence)";
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /where the response it ends on says "the model declined this request"/);
});

test("the refusal category the response records is the one the run has to report", async () => {
  const store = new MemoryStore();
  const result = await record(store, {
    turns: [{ content: [text("I can't help with that.")], stopReason: "refusal" }],
  });

  // A refusal with a category, recorded end to end: the response carries it and
  // so does the closing line.
  const withCategory = tampered(
    result.events,
    (e) => e.type === "effect" && e.key === "step:0",
    (e) => {
      if (e.type === "effect") (e.value as ModelResponse).refusalCategory = "self_harm";
    },
  );
  const consistent = tampered(
    withCategory,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.error = "the model declined this request (self_harm)";
    },
  );

  assert.equal(conclusionOf(verifyEvents("baseline", consistent, store)).status, "ok");
  // The same response, with the category dropped from the line a reader sees.
  assert.equal(conclusionOf(verifyEvents("baseline", withCategory, store)).status, "failed");
});

test("a run out of steps used every step its agent allows, and says the last thing said", async () => {
  const store = new MemoryStore();
  const short = defineAgent({ name: "researcher", model: "claude-opus-5", maxSteps: 2 });
  const result = await record(store, {
    agentSpec: short,
    turns: [
      { content: [text("thinking"), toolUse("t1", "lookup", { term: "alpha" })] },
      { content: [text("still thinking"), toolUse("t2", "lookup", { term: "beta" })] },
    ],
  });

  assert.equal(result.status, "max_steps");
  const check = conclusionOf(verifyRun("baseline", store));
  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /stopped at the 2 steps the agent allows/);

  // The answer such a run carries is the last thing the model actually said,
  // which is the one nothing but this check reads.
  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.output = "alpha and beta, explained";
    },
  );
  const broken = conclusionOf(verifyEvents("baseline", doctored, store));
  assert.equal(broken.status, "failed");
  assert.match(broken.detail, /the last thing the model said is "still thinking"/);
});

test("a run cannot claim it ran out of steps it never took", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") {
        e.status = "max_steps";
        e.error = "stopped after 6 steps without a final answer";
      }
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /the log starts 3 steps of the 6 the agent allows/);
});

test("a failed run reports the message the call it died on recorded", async () => {
  const store = new MemoryStore();
  const result = await run("explain alpha and beta", {
    agent,
    provider: new ThrowingProvider(script(), 2),
    tools: [lookup],
    store,
    runId: "died",
  });

  assert.equal(result.status, "failed");
  const check = conclusionOf(verifyRun("died", store));
  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /failed on model:step:1, with the message that call recorded/);
});

test("a failure rewritten in the closing line no longer matches the call that threw", async () => {
  const store = new MemoryStore();
  const result = await run("explain alpha and beta", {
    agent,
    provider: new ThrowingProvider(script(), 2),
    tools: [lookup],
    store,
    runId: "died",
  });

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.error = "the corpus was unreachable";
    },
  );

  const check = conclusionOf(verifyEvents("died", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /the call it died on \(model:step:1\) recorded "the model is overloaded/);
});

test("a budget stop names a limit the run's own budget declares", async () => {
  const store = new MemoryStore();
  const result = await record(store, { budget: { steps: 2 } });

  assert.equal(result.status, "budget_exceeded");
  const check = conclusionOf(verifyRun("baseline", store));
  assert.equal(check.status, "ok", check.detail);
  assert.match(check.detail, /stopped at a limit its own budget declares/);
});

test("a run cannot report exceeding a limit it never set", async () => {
  const store = new MemoryStore();
  const result = await record(store, { budget: { steps: 2 } });

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.error = "budget exceeded: usd limit is 5, this step would reach 6";
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /which is not a limit its budget declares/);
});

test("a log ending while the run is still running is a state the loop cannot write", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const doctored = tampered(
    result.events,
    (e) => e.type === "run.finished",
    (e) => {
      if (e.type === "run.finished") e.status = "running";
    },
  );

  const check = conclusionOf(verifyEvents("baseline", doctored, store));

  assert.equal(check.status, "failed");
  assert.match(check.detail, /having finished and as still running/);
});

test("a killed log has no conclusion to check, and says so rather than passing", async () => {
  const store = new MemoryStore();
  const result = await record(store);

  const killed = structuredClone(result.events).filter(
    (e) => e.type !== "run.finished",
  ) as RetraceEvent[];

  const report = verifyEvents("baseline", killed, store);
  const check = conclusionOf(report);

  assert.equal(check.status, "skipped");
  assert.equal(report.ok, true, "a log that has not ended is short of a check, not failing one");
  assert.match(check.detail, /has not yet said how it ended/);
});

test("the CLI names the conclusion among its checks, and fails the run on it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-conclusion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RunStore(dir);
  await record(store);

  const path = join(dir, "runs", "baseline.jsonl");
  const doctored = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as RetraceEvent;
      if (event.type === "run.finished") event.output = "an answer nobody gave";
      return JSON.stringify(event);
    });
  writeFileSync(path, `${doctored.join("\n")}\n`, "utf8");

  let printed = "";
  const io: Io = { out: (s) => (printed += s), err: (s) => (printed += s) };
  const code = await main(["verify", "baseline", "--dir", dir], io);
  const plain = printed.replace(/\x1b\[[0-9;]*m/g, "");

  assert.equal(code, 1);
  assert.match(plain, /fail\s+conclusion/);
  assert.match(plain, /an answer nobody gave/);
  assert.match(plain, /unverified: conclusion/);
});

/** Throws on the nth live call and reads the script for the rest. */
class ThrowingProvider extends MockProvider {
  private live = 0;
  private readonly failOn: number;

  constructor(script: ScriptedTurn[], failOn: number) {
    super(script);
    this.failOn = failOn;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.live++;
    if (this.live === this.failOn) {
      const error = new Error("the model is overloaded, try again");
      error.name = "APIOverloadedError";
      throw error;
    }
    return super.complete(request);
  }
}
