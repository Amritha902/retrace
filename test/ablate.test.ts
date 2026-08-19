import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";
import {
  ablateRun,
  compareRuns,
  defineAgent,
  DROPPED,
  effectsOf,
  inspect,
  MemoryStore,
  run,
  RunStore,
  tool,
  verifyRun,
  objectSchema,
  type RunStore as Store,
} from "../src/index.ts";
import { provider, tools } from "./fixtures/ablate-module.ts";
import { tools as movingTools } from "./fixtures/moving-module.ts";

const MODULE = fileURLToPath(new URL("./fixtures/ablate-module.ts", import.meta.url));
const MOVING_MODULE = fileURLToPath(new URL("./fixtures/moving-module.ts", import.meta.url));

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 8,
});

/**
 * Four steps: look "alpha", "beta" and "gamma" up, then answer with the first
 * and the last. The middle answer is in the log and in no part of the
 * conclusion, which is the thing an ablation exists to find out and the thing
 * no reading of the log can.
 */
async function record(store: Store): Promise<void> {
  await run("explain them", { agent, provider, tools, store, runId: "baseline" });
}

const RECORDED_ANSWER = "definition of alpha + definition of gamma";
const KEYS = ["step:0#0:lookup", "step:1#0:lookup", "step:2#0:lookup"];

test("the recorded run is the one the ablations below take answers away from", async () => {
  const store = new MemoryStore();
  await record(store);

  const parent = inspect("baseline", store);
  assert.equal(parent.status, "completed");
  assert.equal(parent.steps, 4);
  assert.equal(parent.output, RECORDED_ANSWER);
});

test("every recorded answer is dropped in turn, in the order the run made the calls", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  assert.deepEqual(
    report.trials.map((t) => t.key),
    KEYS,
  );
  assert.deepEqual(
    report.trials.map((t) => t.step),
    [0, 1, 2],
  );
  assert.deepEqual(
    report.trials.map((t) => t.recorded.content),
    ["definition of alpha", "definition of beta", "definition of gamma"],
  );
  assert.deepEqual(
    report.trials.map((t) => t.input),
    [{ term: "alpha" }, { term: "beta" }, { term: "gamma" }],
  );
  assert.equal(report.recorded, RECORDED_ANSWER);
  assert.equal(report.instead, DROPPED);
});

test("only the answers the conclusion rests on come back needed", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  assert.deepEqual(
    report.trials.map((t) => t.verdict),
    ["needed", "spare", "needed"],
  );
  assert.deepEqual(
    report.trials.map((t) => t.output),
    [
      `${DROPPED} + definition of gamma`,
      RECORDED_ANSWER,
      `definition of alpha + ${DROPPED}`,
    ],
  );
  assert.equal(report.needed, 2);
  assert.equal(report.spare, 1);
});

test("the run the middle answer was taken out of still ends where the recorded one did", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });
  const spare = report.trials[1]!;

  // The point of the `spare` verdict, spelled out: the fork is a real run that
  // saw a different world at step 1 and arrived at the recorded answer anyway.
  const made = inspect(spare.runId, store);
  assert.equal(made.status, "completed");
  assert.equal(made.output, RECORDED_ANSWER);
  assert.equal(made.forkedFrom?.runId, "baseline");
  assert.equal(made.forkedFrom?.atStep, 2);
  assert.deepEqual(made.forkedFrom?.overrides, ["step:1#0:lookup"]);
});

test("nothing below a drop goes stale, because the cut is the tightest the log allows", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  // Forking at the step *after* the call keeps the model turn that asked for it
  // and every call beside it answering exactly what they were recorded against.
  // A cut lower down would leave the steps between it and the drop replaying
  // against a conversation that no longer exists, and the trial would be a
  // counterfactual mixed with an older question.
  for (const trial of report.trials) {
    assert.deepEqual(trial.staleFacets, [], `${trial.key} replayed a stale prefix`);
  }
});

test("each trial is held to the prefix of the run it came from, minus the one value", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  assert.equal(report.control.ok, true);
  assert.equal(report.control.forks, 3);
  assert.equal(report.control.excused, 3, "one substituted value apiece, and no more");
  // Two effects per step below the fork point — a model call and a tool call —
  // so the three cuts replay 2, 4 and 6 of them.
  assert.deepEqual(
    report.trials.map((t) => t.claimed),
    [2, 4, 6],
  );
  assert.equal(report.control.claimed, 12);
});

test("a trial is a real run in the store, forkable and verifiable like any other", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });
  const trial = report.trials[0]!;

  const verified = verifyRun(trial.runId, store as unknown as RunStore);
  assert.equal(verified.ok, true, JSON.stringify(verified.checks));

  const seen = compareRuns("baseline", trial.runId, store as unknown as RunStore);
  assert.equal(seen.ok, true);
  assert.deepEqual(seen.kinship, {
    kind: "parent",
    parent: "a",
    origin: { runId: "baseline", atStep: 1, overrides: ["step:0#0:lookup"] },
  });
  assert.equal(seen.excused, 1, "the dropped value is the one place they are meant to differ");
});

test("the prefix below each drop is free, and the report says what that came to", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  for (const trial of report.trials) {
    assert.ok(trial.savedUsd > 0, `${trial.key} replayed nothing`);
    assert.ok(
      Math.abs(trial.costUsd - (trial.billedUsd + trial.savedUsd)) < 1e-9,
      "what a trial was worth is what it was billed plus what it did not pay again",
    );
  }
  // The deepest cut replays the most and pays for the least, which is the whole
  // reason asking this question of every call is affordable.
  assert.ok(report.trials[2]!.savedUsd > report.trials[0]!.savedUsd);
  assert.ok(report.trials[2]!.billedUsd < report.trials[0]!.billedUsd);
  assert.ok(
    Math.abs(report.costUsd - (report.billedUsd + report.savedUsd)) < 1e-9,
    "and the totals add up the same way",
  );
});

test("the stand-in is the counterfactual, and a caller can name a different one", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store, instead: "nothing found" });

  assert.equal(report.instead, "nothing found");
  assert.equal(report.trials[0]!.output, "nothing found + definition of gamma");
  assert.equal(report.trials[1]!.verdict, "spare", "still the answer the conclusion never read");
});

test("only narrows the ablation to the calls of one tool", async () => {
  const store = new MemoryStore();
  await record(store);

  const named = await ablateRun("baseline", { provider, tools, store, only: ["lookup"] });
  assert.equal(named.trials.length, 3);

  const other = await ablateRun("baseline", { provider, tools, store, only: ["search"] });
  assert.deepEqual(other.trials, [], "this run made no call to a tool by that name");
  assert.equal(other.control.forks, 0);
  assert.equal(other.needed, 0);
});

test("max-forks caps the walk and says which calls were left alone", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store, maxForks: 2 });

  assert.deepEqual(
    report.trials.map((t) => t.key),
    KEYS.slice(0, 2),
  );
  assert.equal(report.stopped, "capped at 2 forks: 1 recorded call was not dropped");
});

test("a run with no tool calls has nothing to take away", async () => {
  const store = new MemoryStore();
  const answered = {
    name: "fixture",
    complete: async () => ({
      model: "claude-opus-5",
      content: [{ type: "text" as const, text: "no tools needed" }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  };
  await run("just answer", { agent, provider: answered, tools: [], store, runId: "bare" });

  const report = await ablateRun("bare", { provider: answered, tools: [], store });
  assert.deepEqual(report.trials, []);
  assert.equal(report.control.ok, true, "nothing to hold is not a contradiction");
  assert.equal(report.control.claimed, 0);
});

test("a fork that never answered is inconclusive rather than counted either way", async () => {
  const store = new MemoryStore();
  await record(store);

  // One step of budget is spent by the replayed prefix itself, so every trial
  // stops before it reaches the live step that would have answered.
  const report = await ablateRun("baseline", { provider, tools, store, budget: { steps: 1 } });

  assert.deepEqual(
    report.trials.map((t) => t.verdict),
    ["inconclusive", "inconclusive", "inconclusive"],
  );
  assert.deepEqual(
    report.trials.map((t) => t.status),
    ["budget_exceeded", "budget_exceeded", "budget_exceeded"],
  );
  assert.equal(report.needed, 0, "a run that did not answer cannot say what its answer needed");
  assert.equal(report.spare, 0);
});

test("a tool that cannot be repeated stops the trials whose tails would call it", async () => {
  const store = new MemoryStore();
  await record(store);

  const once = tools.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      inputSchema: objectSchema({ term: { type: "string" } }),
      irreversible: true,
      run: (input: { term: string }) => `definition of ${input.term}`,
    }),
  );
  const report = await ablateRun("baseline", { provider, tools: once, store });

  // Dropping the last recorded answer leaves a tail with no tool call in it, so
  // that trial runs. The two above it would call the tool again for real, which
  // is the fork hazard and not something an ablation gets an exemption from.
  assert.deepEqual(
    report.trials.map((t) => t.status),
    ["failed", "failed", "completed"],
  );
  assert.deepEqual(
    report.trials.map((t) => t.verdict),
    ["inconclusive", "inconclusive", "needed"],
  );
  assert.match(report.trials[0]!.error ?? "", /irreversible/);
});

test("the effects a trial's log holds are its parent's, with the drop marked", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });
  const trial = report.trials[1]!;
  const effects = effectsOf(store.read(trial.runId));

  const dropped = effects.find((e) => e.key === "step:1#0:lookup");
  assert.equal(dropped?.overridden, true);
  assert.deepEqual(dropped?.value, { content: DROPPED, isError: false });
  assert.equal(dropped?.replayed, true, "the drop is served from the log, never executed");
  // Everything else below the fork point is the parent's, unmarked.
  assert.deepEqual(
    effects.filter((e) => e.replayed && e.overridden !== true).map((e) => e.key),
    ["step:0", "step:0#0:lookup", "step:1"],
  );
});

/**
 * The same three lookups, from a corpus that answers a second execution
 * differently.
 *
 * Nothing about the recorded run changes — each term is looked up once. What
 * changes is what a *fork* sees: its live tail re-executes the calls above its
 * cut, and gets the corpus as it is now. That is the ordinary way an ablation
 * goes wrong, and the thing a single trial cannot see: the answer moves, and
 * the value the trial dropped had nothing to do with it.
 */
function movingCorpus() {
  const seen = new Set<string>();
  return [
    tool({
      name: "lookup",
      description: "Look a term up. Call this when you need a fact you don't have.",
      inputSchema: objectSchema({ term: { type: "string" } }),
      run: (input: { term: string }) => {
        const again = seen.has(input.term);
        seen.add(input.term);
        return again ? `definition of ${input.term} (again)` : `definition of ${input.term}`;
      },
    }),
  ];
}

test("each cut is re-entered with nothing dropped, and the trials say it reproduced", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  // One per cut, in cut order — not one per trial. Every call recorded in a
  // step is dropped from a fork at the step after it, so the cuts are what the
  // trials share and one fork answers for all of them.
  assert.deepEqual(
    report.baselines.map((b) => b.atStep),
    [1, 2, 3],
  );
  for (const made of report.baselines) {
    assert.equal(made.status, "completed");
    assert.equal(made.output, RECORDED_ANSWER);
    assert.equal(made.reproduced, true, `step ${made.atStep} did not arrive where the run did`);
  }
  assert.equal(report.unstable, 0);
});

test("a trial names the baseline it was read against, and differs from it in one value", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });
  const trial = report.trials[1]!;
  const made = report.baselines.find((b) => b.atStep === trial.step + 1)!;

  assert.equal(trial.baselineRunId, made.runId);

  // The pair is the measurement: same parent, same cut, same live tail, and one
  // substituted value between them. `diff` holds them to it as siblings, which
  // is a check neither of them needs the run they came from to make.
  const seen = compareRuns(trial.runId, made.runId, store as unknown as RunStore);
  assert.equal(seen.ok, true);
  assert.equal(seen.kinship.kind, "siblings");
  assert.equal(seen.excused, 1, "the dropped value is the one place they are meant to differ");
});

test("a cut the run does not reproduce from carries no verdict about a drop", async () => {
  const store = new MemoryStore();
  const moving = movingCorpus();
  await run("explain them", { agent, provider, tools: moving, store, runId: "baseline" });

  const report = await ablateRun("baseline", { provider, tools: moving, store });

  // Cutting at step 3 leaves a tail with no tool call in it, so that fork reads
  // nothing and arrives where the run did. The two cuts below it re-execute a
  // lookup, and the corpus has moved.
  assert.deepEqual(
    report.baselines.map((b) => [b.atStep, b.reproduced]),
    [
      [1, false],
      [2, false],
      [3, true],
    ],
  );
  assert.deepEqual(
    report.baselines.map((b) => b.output),
    [
      "definition of alpha + definition of gamma (again)",
      "definition of alpha + definition of gamma (again)",
      RECORDED_ANSWER,
    ],
  );

  // Both trials below answered something other than the recorded answer, and a
  // command without a baseline would have reported both of them `needed`. The
  // middle one is the sharper half: dropping "beta" changed nothing, and the
  // answer moved anyway.
  assert.deepEqual(
    report.trials.map((t) => t.verdict),
    ["unstable", "unstable", "needed"],
  );
  assert.equal(report.trials[1]!.output, "definition of alpha + definition of gamma (again)");
  assert.equal(report.unstable, 2);
  assert.equal(report.needed, 1, "only the cut that reproduces can report a dependency");
  assert.equal(report.spare, 0);
});

test("the baselines can be skipped, and then a trial is a single draw again", async () => {
  const store = new MemoryStore();
  const moving = movingCorpus();
  await run("explain them", { agent, provider, tools: moving, store, runId: "baseline" });

  const report = await ablateRun("baseline", { provider, tools: moving, store, baseline: false });

  // The same three trials, and the verdict the recorded answer alone supports:
  // two of them are the false `needed` the baselines above turned back.
  assert.deepEqual(report.baselines, []);
  assert.deepEqual(
    report.trials.map((t) => t.verdict),
    ["needed", "needed", "needed"],
  );
  assert.equal(report.trials[1]!.baselineRunId, undefined);
  assert.equal(report.control.baselines, 0);
  assert.equal(report.control.baselineClaimed, 0);
});

test("one baseline serves every call recorded in the same step", async () => {
  const store = new MemoryStore();
  // Step 0 asks for both lookups at once, so both drops cut at step 1.
  const pair: typeof provider = {
    name: "fixture",
    async complete(request) {
      const answered = request.messages.some((m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      );
      return {
        model: request.model,
        content: answered
          ? [{ type: "text", text: "both" }]
          : [
              { type: "tool_use", id: "t0", name: "lookup", input: { term: "alpha" } },
              { type: "tool_use", id: "t1", name: "lookup", input: { term: "beta" } },
            ],
        stopReason: answered ? "end_turn" : "tool_use",
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  await run("both", { agent, provider: pair, tools, store, runId: "baseline" });

  const report = await ablateRun("baseline", { provider: pair, tools, store });

  assert.deepEqual(
    report.trials.map((t) => t.key),
    ["step:0#0:lookup", "step:0#1:lookup"],
  );
  assert.equal(report.baselines.length, 1, "two drops, one cut, one fork to establish it");
  assert.equal(report.baselines[0]!.atStep, 1);
  assert.deepEqual(new Set(report.trials.map((t) => t.baselineRunId)), new Set([report.baselines[0]!.runId]));
});

test("the baselines are held to the prefix they replayed, and are paid for in the totals", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await ablateRun("baseline", { provider, tools, store });

  assert.equal(report.control.ok, true);
  assert.equal(report.control.forks, 3, "the trials, which is what `excused` is about");
  assert.equal(report.control.baselines, 3);
  // A baseline cuts where its trials cut, so it replays exactly what they do —
  // and substitutes nothing, so every position it replayed is owed unexcused.
  assert.equal(report.control.baselineClaimed, report.control.claimed);
  assert.equal(report.control.excused, 3);

  const spent = [...report.trials, ...report.baselines];
  assert.ok(
    Math.abs(report.costUsd - spent.reduce((n, r) => n + r.costUsd, 0)) < 1e-9,
    "the report's arithmetic covers every fork the command made, baselines included",
  );
  for (const made of report.baselines) assert.ok(made.savedUsd > 0, "a baseline replays a prefix too");
});

test("retrace ablate reports a cut that does not reproduce rather than a dependency", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  // The same module the CLI is about to load, so the corpus it moves under is
  // the corpus this run recorded.
  await run("explain them", { agent, provider, tools: movingTools, store, runId: "baseline" });

  const io = capture();
  const code = await main(["ablate", "baseline", "--dir", dir, "--module", MOVING_MODULE], io);
  const text = plain(io.text);

  assert.equal(code, 1, "a run that does not reproduce from its cuts is not a clean ablation");
  assert.match(text, /did not reproduce: 2 of 3 forks made with nothing dropped answered something else — step 1, step 2/);
  assert.match(text, /step:0#0:lookup\s+unstable/);
  assert.match(text, /step:1#0:lookup\s+unstable/);
  assert.match(text, /step:2#0:lookup\s+needed/);
  assert.match(
    text,
    /2 trials cut where the run does not reproduce itself \(step 1, step 2\), so what they answered is not a fact about the dropped value/,
  );
});

test("retrace ablate --no-baseline makes the drops and nothing else", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  await record(store);

  const io = capture();
  const code = await main(
    ["ablate", "baseline", "--dir", dir, "--module", MODULE, "--no-baseline"],
    io,
  );
  const text = plain(io.text);

  assert.equal(code, 0, text);
  assert.match(text, /2 of 3 recorded answers this run's conclusion depends on/);
  assert.match(text, /3 forks · \$/);
  assert.doesNotMatch(text, /re-entered at step/);
  assert.doesNotMatch(text, /replayed the same prefixes whole/);
});

/** A disk-backed store, since the CLI reads runs by id from one. */
function diskStore(t: TestContext): { dir: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "retrace-ablate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new RunStore(dir) };
}

function capture(): Io & { text: string } {
  const io = {
    text: "",
    out(text: string) {
      io.text += text;
    },
    err(text: string) {
      io.text += text;
    },
  };
  return io;
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("retrace ablate prints each dropped answer, its verdict and its run", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  await record(store);

  const io = capture();
  const code = await main(["ablate", "baseline", "--dir", dir, "--module", MODULE], io);
  const text = plain(io.text);

  assert.equal(code, 0, text);
  assert.match(text, /3 recorded tool calls, each dropped from the step after it/);
  assert.match(text, /step:0#0:lookup\s+needed/);
  assert.match(text, /step:1#0:lookup\s+spare/);
  assert.match(text, /step:2#0:lookup\s+needed/);
  assert.match(text, /dropped \{"term":"beta"\} → definition of beta/);
  assert.match(text, /2 of 3 recorded answers this run's conclusion depends on/);
  assert.match(
    text,
    /controlled: each of 3 forks replayed baseline's prefix unchanged except the one value it dropped — 12 effects in all/,
  );
  assert.match(text, /and 3 baselines replayed the same prefixes whole — 12 effects more/);
  assert.match(
    text,
    /reproduced: 3 forks re-entered the run at the same cuts with nothing dropped, and all of them arrived at the recorded answer/,
  );
  // Three drops and the three cuts they were made at, which is what the money
  // line has to count if it is to be the price of the command.
  assert.match(text, /6 forks · \$/);
});

test("retrace ablate takes the stand-in and the cap from the command line", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  await record(store);

  const io = capture();
  const code = await main(
    [
      "ablate",
      "baseline",
      "--dir",
      dir,
      "--module",
      MODULE,
      "--instead",
      "nothing found",
      "--max-forks",
      "1",
    ],
    io,
  );
  const text = plain(io.text);

  assert.equal(code, 0, text);
  assert.match(text, /nothing found \+ definition of gamma/);
  assert.match(text, /capped at 1 fork: 2 recorded calls were not dropped/);
});

test("retrace ablate says so rather than exiting quietly when a trial never answered", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  await record(store);

  const io = capture();
  const code = await main(
    ["ablate", "baseline", "--dir", dir, "--module", MODULE, "--tool", "nothing"],
    io,
  );
  const text = plain(io.text);

  assert.equal(code, 0, text);
  assert.match(text, /0 of 0 recorded answers/);
  assert.match(text, /no fork ran, so there was nothing to hold to a prefix/);
});

test("retrace ablate needs a run and the module its live tails run", async (t: TestContext) => {
  const { dir, store } = diskStore(t);
  await record(store);

  const missing = capture();
  assert.equal(await main(["ablate", "--dir", dir], missing), 1);
  assert.match(plain(missing.text), /ablate needs a run id/);

  const noModule = capture();
  assert.equal(await main(["ablate", "baseline", "--dir", dir], noModule), 1);
  assert.match(plain(noModule.text), /ablate needs --module/);
});
