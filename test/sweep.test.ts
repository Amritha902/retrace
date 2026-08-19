import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";
import { loadRunModule } from "../src/module.ts";
import {
  compareRuns,
  defineAgent,
  effectsOf,
  inspect,
  MemoryStore,
  run,
  RunStore,
  sweepForkPoint,
  verifyRun,
  type RunStore as Store,
} from "../src/index.ts";
import { arms, provider, tools } from "./fixtures/sweep-module.ts";
import {
  arms as wobbleArms,
  provider as wobbleProvider,
  resetWobble,
  tools as wobbleTools,
} from "./fixtures/sweep-wobble-module.ts";

const MODULE = fileURLToPath(new URL("./fixtures/sweep-module.ts", import.meta.url));
const WOBBLE = fileURLToPath(new URL("./fixtures/sweep-wobble-module.ts", import.meta.url));

const agent = defineAgent({
  name: "researcher",
  model: "claude-opus-5",
  system: "You are terse.",
  maxSteps: 6,
});

/**
 * Three steps: look "alpha" up, look "beta" up, answer with both and with the
 * prompt that asked. Forking at step 2 replays both lookups and leaves only the
 * answer live, which is the shape a sweep is for — the arms differ in the one
 * step they pay for.
 */
async function record(store: Store): Promise<void> {
  await run("explain alpha and beta", {
    agent,
    provider,
    tools,
    store,
    runId: "baseline",
  });
}

const RECORDED_ANSWER = "You are terse. :: definition of alpha | definition of beta";

test("the recorded run is the one the sweeps below re-enter", async () => {
  const store = new MemoryStore();
  await record(store);

  const parent = inspect("baseline", store);
  assert.equal(parent.status, "completed");
  assert.equal(parent.steps, 3);
  assert.equal(parent.output, RECORDED_ANSWER);
});

test("every arm answers its own question, off the same replayed prefix", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  assert.deepEqual(
    report.arms.map((a) => a.name),
    ["terse", "cited", "empty-corpus"],
    "in the order the module declared them",
  );
  assert.deepEqual(
    report.arms.map((a) => a.output),
    [
      "Answer in ten words. :: definition of alpha | definition of beta",
      "Cite what you searched. :: definition of alpha | definition of beta",
      "You are terse. :: no results | definition of beta",
    ],
  );
  assert.equal(report.recorded, RECORDED_ANSWER);
  assert.equal(report.atStep, 2);
  assert.ok(report.arms.every((a) => a.status === "completed"));
});

test("each arm's own log says which part of the request its change moved", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  assert.deepEqual(
    report.arms.map((a) => a.staleFacets),
    [["system"], ["system"], ["conversation"]],
    "a rewritten prompt moves the system prompt; a substituted value moves the conversation",
  );
});

test("the arms are held to the prefix they all replayed, and the substitution is excused", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  assert.equal(report.control.ok, true);
  assert.equal(report.control.arms, 3);
  assert.equal(report.control.claimed, 4, "two model calls and two tool calls below step 2");
  assert.equal(report.control.excused, 1, "the one value the third arm was told to substitute");

  // The same claim from the outside: any two arms are siblings, and `diff`
  // holds siblings to the prefix they both took out of the run they came from.
  const [a, , c] = report.arms;
  const seen = compareRuns(a!.runId!, c!.runId!, store);
  assert.equal(seen.kinship.kind, "siblings");
  assert.equal(seen.ok, true);
  assert.equal(seen.claimed, 4);
  assert.equal(seen.excused, 1);
});

test("what the arms did not pay for is the prefix they shared", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  for (const arm of report.arms) {
    assert.ok(arm.savedUsd > 0, `${arm.name} replayed a prefix it was not billed for`);
    assert.ok(arm.billedUsd > 0, `${arm.name} ran its own live tail`);
    assert.ok(arm.billedUsd < arm.costUsd);
  }
  assert.ok(report.savedUsd > report.billedUsd, "three answers for less than the prefix was worth");
  assert.equal(
    report.costUsd.toFixed(6),
    (report.billedUsd + report.savedUsd).toFixed(6),
    "list price is what was billed plus what was not spent again",
  );
});

test("every arm is a real run in the store, and verifies as one", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  for (const arm of report.arms) {
    const verdict = verifyRun(arm.runId!, store);
    assert.equal(verdict.ok, true, `${arm.name}: ${JSON.stringify(verdict.checks)}`);
    assert.equal(inspect(arm.runId!, store).forkedFrom?.runId, "baseline");
  }
});

test("an arm the runtime refuses takes itself out of the sweep and nothing else", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atStep: 2,
    arms: [
      // Step 2 runs live, so nothing would be served in place of its model call
      // — `fork` refuses the counterfactual rather than ignoring it.
      { name: "too-late", overrides: { "step:2": "never read" } },
      { name: "terse", agent: { system: "Answer in ten words." } },
    ],
  });

  assert.equal(report.arms[0]?.status, "not_run");
  assert.equal(report.arms[0]?.runId, undefined);
  assert.match(report.arms[0]?.error ?? "", /which this fork runs live/);
  assert.equal(report.arms[0]?.billedUsd, 0);

  assert.equal(report.arms[1]?.status, "completed");
  assert.equal(report.arms[1]?.output, "Answer in ten words. :: definition of alpha | definition of beta");
  assert.equal(report.control.arms, 1, "one arm ran, so there was nothing to hold it against");
  assert.equal(report.control.ok, true);
});

test("a sweep can cut inside a step, keeping the turn that asked for the call", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atEffect: "step:1#0:lookup",
    arms: [{ name: "as-recorded" }, { name: "empty-corpus", overrides: { "step:0#0:lookup": "no results" } }],
  });

  assert.equal(report.atEffect, "step:1#0:lookup");
  assert.equal(report.arms[0]?.output, RECORDED_ANSWER, "no change, so the recorded answer");
  assert.equal(report.arms[1]?.output, "You are terse. :: no results | definition of beta");
  assert.equal(report.control.claimed, 3, "two effects of step 0, and step 1's model call");
  assert.equal(report.control.ok, true);
});

test("arms without names are read by their position, and two of one name are refused", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atStep: 2,
    arms: [{ agent: { system: "One." } }, { agent: { system: "Two." } }],
  });
  assert.deepEqual(
    report.arms.map((a) => a.name),
    ["arm 1", "arm 2"],
  );

  await assert.rejects(
    sweepForkPoint("baseline", {
      provider,
      tools,
      store,
      atStep: 2,
      arms: [{ name: "same" }, { name: "same" }],
    }),
    /two arms of this sweep are named "same"/,
  );
});

test("nothing an arm replayed executed a tool", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  for (const arm of report.arms) {
    const replayed = effectsOf(store.read(arm.runId!)).filter((e) => e.replayed);
    assert.equal(replayed.length, 4);
    assert.ok(
      replayed.every((e) => e.durationMs === 0),
      "a replayed effect takes no time, because nothing ran",
    );
  }
});

test("the module supplies the arms, and says so when it doesn't", async () => {
  const loaded = await loadRunModule(MODULE);
  assert.deepEqual(
    loaded.arms?.map((a) => a.name),
    ["terse", "cited", "empty-corpus"],
  );
  assert.deepEqual(loaded.arms?.[2]?.overrides, { "step:0#0:lookup": "no results" });

  const other = fileURLToPath(new URL("./fixtures/search-module.ts", import.meta.url));
  assert.equal((await loadRunModule(other)).arms, undefined);
});

test("the CLI puts the arms side by side and says what they shared", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(["sweep", "baseline", "--at", "2", "--dir", dir, "--module", MODULE], io);

  assert.equal(code, 0);
  const text = io.text();
  assert.match(text, /3 arms at step 2, off one replayed prefix/);
  assert.match(text, /terse\s+completed/);
  assert.match(text, /Answer in ten words\. :: definition of alpha \| definition of beta/);
  assert.match(text, /empty-corpus\s+completed.*conversation/s);
  assert.match(text, /sweep_\d{8}T?\d*_?\w+/, "each arm names the run it made, for show and diff");
  assert.match(
    text,
    /controlled: 4 effects replayed identically by all 3 arms, 1 of them a value an arm was told to substitute/,
  );
  assert.match(text, /3 arms · \$.* billed · \$.* not spent again out of \$/);
});

test("the CLI exits non-zero when an arm did not run, and says why", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  // --set applies to every arm, and at this fork point step 2 runs live.
  const code = await main(
    ["sweep", "baseline", "--at", "2", "--dir", dir, "--module", MODULE, "--set", "step:2=late"],
    io,
  );

  assert.equal(code, 1);
  assert.match(io.text(), /not_run/);
  assert.match(io.text(), /which this fork runs live/);
});

test("sweep asks for the run, the fork point and the arms it needs", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  assert.equal(await main(["sweep", "--dir", dir, "--module", MODULE, "--at", "2"], io), 1);
  assert.match(io.text(), /sweep needs a run id/);

  assert.equal(await main(["sweep", "baseline", "--dir", dir, "--module", MODULE], io), 1);
  assert.match(io.text(), /sweep needs --at/);

  assert.equal(await main(["sweep", "baseline", "--at", "2", "--dir", dir], io), 1);
  assert.match(io.text(), /sweep needs --module/);

  const bare = fileURLToPath(new URL("./fixtures/search-module.ts", import.meta.url));
  assert.equal(
    await main(["sweep", "baseline", "--at", "2", "--dir", dir, "--module", bare], io),
    1,
  );
  assert.match(io.text(), /exports no arms/);
});

test("an arm is cut once unless the sweep is asked for more", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms });

  assert.equal(report.repeat, 1);
  for (const arm of report.arms) {
    assert.equal(arm.runs.length, 1);
    assert.equal(arm.alike, 1);
    assert.equal(arm.unstable, false, "one draw cannot disagree with itself");
    assert.equal(arm.runs[0]?.runId, arm.runId, "the arm reads as the one fork it made");
  }
});

test("repeat cuts every arm that many times, and every cut is a run of its own", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atStep: 2,
    arms,
    repeat: 3,
  });

  assert.equal(report.repeat, 3);
  const made = new Set<string>();
  for (const arm of report.arms) {
    assert.equal(arm.runs.length, 3, `${arm.name} was cut three times`);
    assert.equal(arm.alike, 3, `${arm.name} answered the same thing every time`);
    assert.equal(arm.unstable, false);
    assert.deepEqual(
      new Set(arm.runs.map((r) => r.output)),
      new Set([arm.output]),
      "and the arm reads as any one of them",
    );
    for (const made_ of arm.runs) {
      assert.equal(made.has(made_.runId), false, "each cut is its own run");
      made.add(made_.runId);
      assert.equal(verifyRun(made_.runId, store).ok, true, `${made_.runId} verifies`);
      assert.equal(inspect(made_.runId, store).forkedFrom?.runId, "baseline");
    }
  }
  assert.equal(made.size, 9, "three arms, three cuts each");
});

test("the cuts of every arm are held to the one prefix all of them replayed", async () => {
  const store = new MemoryStore();
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atStep: 2,
    arms,
    repeat: 3,
  });

  assert.equal(report.control.ok, true);
  assert.equal(report.control.arms, 3);
  assert.equal(report.control.runs, 9, "every fork the sweep made, not one per arm");
  assert.equal(report.control.claimed, 4, "two model calls and two tool calls below step 2");
  assert.equal(report.control.excused, 1, "the one value the third arm was told to substitute");

  // The claim from the outside, on two cuts of the *same* arm: they are
  // siblings like any other pair, and differ in nothing below the fork point —
  // which leaves the model as the only thing a difference between them can be.
  const [first, second] = report.arms[0]!.runs;
  const seen = compareRuns(first!.runId, second!.runId, store);
  assert.equal(seen.kinship.kind, "siblings");
  assert.equal(seen.ok, true);
  assert.equal(seen.claimed, 4);
});

test("an arm whose answer moved on its own comes back unstable, and the rest still stands", async () => {
  const store = new MemoryStore();
  resetWobble();
  await run("explain alpha and beta", {
    agent,
    provider: wobbleProvider,
    tools: wobbleTools,
    store,
    runId: "baseline",
  });
  resetWobble();

  const report = await sweepForkPoint("baseline", {
    provider: wobbleProvider,
    tools: wobbleTools,
    store,
    atStep: 2,
    arms: wobbleArms,
    repeat: 3,
  });

  const [steady, wobbly] = report.arms;
  assert.equal(steady?.unstable, false);
  assert.equal(steady?.alike, 3);
  assert.equal(steady?.output, "Answer plainly. :: definition of alpha | definition of beta");

  assert.equal(wobbly?.unstable, true, "it hedged on the second of its three cuts");
  assert.equal(wobbly?.alike, 2);
  assert.deepEqual(
    wobbly?.runs.map((r) => r.output),
    [
      "Answer, and hedge it. :: definition of alpha | definition of beta",
      "Answer, and hedge it. :: definition of alpha | definition of beta, or so they say",
      "Answer, and hedge it. :: definition of alpha | definition of beta",
    ],
  );
  // The finding is about the one arm. Nothing about the other arm's answer is
  // in doubt, and the prefix both of them replayed is held either way.
  assert.equal(report.control.ok, true);
  assert.equal(report.control.runs, 6);
});

test("a cut that stopped somewhere else is not the same answer as one that finished", async () => {
  const store = new MemoryStore();
  resetWobble();
  await run("explain alpha and beta", {
    agent,
    provider: wobbleProvider,
    tools: wobbleTools,
    store,
    runId: "baseline",
  });
  resetWobble();

  const report = await sweepForkPoint("baseline", {
    provider: wobbleProvider,
    tools: wobbleTools,
    store,
    atStep: 2,
    // This prompt answers once and throws the next time, so the second cut ends
    // where the first one answered — no answer at all rather than another one.
    arms: [{ name: "brittle", agent: { system: "Answer, and break sometimes." } }],
    repeat: 2,
  });

  const brittle = report.arms[0]!;
  assert.equal(brittle.runs.length, 2);
  assert.equal(brittle.runs[0]?.status, "completed");
  assert.equal(brittle.runs[1]?.status, "failed");
  assert.equal(brittle.status, "completed", "the arm reads as the first of its cuts");
  assert.equal(brittle.unstable, true, "how a cut ended is part of what it answered");
  assert.equal(brittle.alike, 1);
});

test("an arm the runtime refuses is refused once, however many cuts were asked for", async (t) => {
  const dir = tempDir(t);
  const store = new RunStore(dir);
  await record(store);

  const report = await sweepForkPoint("baseline", {
    provider,
    tools,
    store,
    atStep: 2,
    arms: [
      { name: "too-late", overrides: { "step:2": "never read" } },
      { name: "terse", agent: { system: "Answer in ten words." } },
    ],
    repeat: 3,
  });

  assert.equal(report.arms[0]?.status, "not_run");
  assert.deepEqual(report.arms[0]?.runs, [], "nothing it was refused for reached the store");
  assert.equal(report.arms[1]?.runs.length, 3);
  // What `fork` refuses is read off the parent's log and the arm's own fields,
  // which every cut of the arm shares — so putting it again would be three
  // identical refusals rather than three draws.
  assert.equal(
    store.list().filter((id) => id.startsWith("sweep")).length,
    3,
    "three forks in the store: the arm that ran, and none for the arm that didn't",
  );
  assert.equal(report.control.arms, 1);
  assert.equal(report.control.runs, 3);
});

test("repeat has to be a whole number of forks per arm", async () => {
  const store = new MemoryStore();
  await record(store);

  for (const repeat of [0, -1, 1.5]) {
    await assert.rejects(
      () => sweepForkPoint("baseline", { provider, tools, store, atStep: 2, arms, repeat }),
      /repeat has to be a whole number of forks per arm, at least 1/,
      `repeat ${repeat} is not a number of forks`,
    );
  }
});

test("the CLI tallies the cuts of each arm and counts them all as controlled", async (t) => {
  const dir = tempDir(t);
  await record(new RunStore(dir));
  const io = capture();

  const code = await main(
    ["sweep", "baseline", "--at", "2", "--dir", dir, "--module", MODULE, "--repeat", "3"],
    io,
  );

  assert.equal(code, 0, "every arm settled, so there is nothing to report");
  const text = io.text();
  assert.match(text, /3 arms at step 2, off one replayed prefix, 3 times over each/);
  assert.match(text, /terse\s+completed\s+3 of 3/);
  assert.match(
    text,
    /controlled: 4 effects replayed identically by all 9 forks of the 3 arms, 1 of them a value an arm was told to substitute/,
  );
  assert.doesNotMatch(text, /unstable/);
});

test("the CLI names the arm that did not settle, says what else it said, and exits non-zero", async (t) => {
  const dir = tempDir(t);
  resetWobble();
  await run("explain alpha and beta", {
    agent,
    provider: wobbleProvider,
    tools: wobbleTools,
    store: new RunStore(dir),
    runId: "baseline",
  });
  resetWobble();
  const io = capture();

  const code = await main(
    ["sweep", "baseline", "--at", "2", "--dir", dir, "--module", WOBBLE, "--repeat", "3"],
    io,
  );

  assert.equal(code, 1);
  const text = io.text();
  assert.match(text, /steady\s+completed\s+3 of 3/);
  assert.match(text, /wobbly\s+unstable\s+2 of 3/);
  assert.match(text, /also: .*, or so they say/, "what it answered the other time");
  assert.match(text, /unstable: "wobbly" answered more than one way at this fork point/);
  assert.match(text, /a\s+difference between it and another arm is not something the arms account for/);
  assert.match(text, /controlled: 4 effects replayed identically by all 6 forks of the 2 arms/);
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): Io & { text(): string } {
  let out = "";
  return {
    out: (s) => (out += s),
    err: (s) => (out += s),
    text: () => out.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}
