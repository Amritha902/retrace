#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { orderFacets } from "./agent.ts";
import { collectBundle, importBundle, parseBundle, serializeBundle } from "./bundle.ts";
import { compareRuns, type EffectPair, type RunComparison } from "./compare.ts";
import { explainStale } from "./explain.ts";
import { loadRunModule, type RunModule } from "./module.ts";
import { formatUsd } from "./pricing.ts";
import type { Overrides } from "./journal.ts";
import {
  effectsOf,
  fork,
  inspect,
  overriddenEffects,
  replay,
  resume,
  staleEffects,
  summarize,
  type ForkPoint,
} from "./replay.ts";
import { executed, recheckRun, type RecheckReport, type RecheckStatus } from "./recheck.ts";
import { renderReport } from "./report.ts";
import { DEFAULT_STORE_DIR, RunStore } from "./store.ts";
import { verifyRun } from "./verify.ts";
import type { ContentBlock, ForkOrigin, Provider, RetraceEvent } from "./types.ts";

const USAGE = `retrace — inspect and re-run recorded agent runs

  retrace ls                    list runs, newest last
  retrace show <run-id>         print the run's timeline
  retrace cost <run-id>         per-step spend, and what replay saved
  retrace diff <run-a> <run-b>  where two runs stopped agreeing, and whether
                                they agree everywhere they had to
  retrace replay <run-id>       re-run it from the log, and check it reproduces
  retrace fork <run-id> --at N  replay the steps below N, then run live
                                (--at <effect-key> re-enters mid-step instead)
  retrace resume <run-id>       carry on a run that stopped early, from its log
  retrace stale <run-id>        say what moved under the steps it replayed, by
                                reading the run it replayed them from
  retrace report <run-id>       write the run as one self-contained HTML page
  retrace verify <run-id>       check the log against its own claims, and what it
                                got free against the runs that executed and paid
  retrace recheck <run-id>      ask the tools whether the log's answers still
                                hold — re-executes every recorded tool call
  retrace export <run-id>       write the run and everything it was forked from
                                as one file, so verify runs whole elsewhere
  retrace import <path>         read such a file into this store

Options
  --dir <path>              store directory (default: ${DEFAULT_STORE_DIR})
  --at <n|effect-key>       where a fork starts executing for real: a step
                            number, or an effect key as show prints it, which
                            replays the rest of that step and goes live at the
                            call itself — "step:2#1:search"
  -o, --out <path>          where report writes its HTML or export its bundle;
                            "-" for stdout (default: <run-id>.html, and
                            <run-id>.bundle.jsonl)
  --module <path>           module exporting the live half of the run — tools,
                            a provider, and agent fields to override. Required
                            by fork and resume; replay only needs it to go past
                            the log.
  --set <key>=<value>       serve <value> in place of the effect recorded under
                            <key>, as show prints it — "step:2#0:search=nothing
                            found". Repeatable; the key must be below --at.
  --on-divergence <policy>  strict (default) stops when the log disagrees with
                            the loop; live executes from that point instead
  --tool <name>             limit recheck to this tool. Repeatable. Everything
                            it runs, it runs for real — this is how you keep it
                            away from a tool that writes something. A call that
                            disagrees with the log is run a second time, to tell
                            a moved corpus from a tool with no settled answer
  --allow-irreversible      execute tools marked irreversible. Without it, a
                            fork, resume or replay stops rather than making such
                            a call a second time, and recheck holds it back
`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Where output goes. Injected so the commands can be tested in-process. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const stdio: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

type Effect = Extract<RetraceEvent, { type: "effect" }>;

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (cause) {
    // A missing run, a corrupt log, a module that won't import: all user errors,
    // none of them worth a stack trace.
    io.err(`${red("error")} ${describe(cause)}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  const dir = takeOption(args, "--dir") ?? DEFAULT_STORE_DIR;
  const modulePath = takeOption(args, "--module");
  const atRaw = takeOption(args, "--at");
  const out = takeOption(args, "-o") ?? takeOption(args, "--out");
  const overrides = readOverrides(takeEvery(args, "--set"));
  const onDivergence = readPolicy(takeOption(args, "--on-divergence"));
  const only = takeEvery(args, "--tool");
  const allowIrreversible = takeFlag(args, "--allow-irreversible");
  const reentry: Reentry = { overrides, onDivergence, allowIrreversible };

  const [command, ...rest] = args;
  const store = new RunStore(dir);

  switch (command) {
    case "ls":
      return cmdLs(io, store);
    case "show":
      return cmdShow(io, store, rest[0]);
    case "cost":
      return cmdCost(io, store, rest[0]);
    case "diff":
      return cmdDiff(io, store, rest[0], rest[1]);
    case "replay":
      return cmdReplay(io, store, rest[0], modulePath, reentry);
    case "fork":
      return cmdFork(io, store, rest[0], atRaw, modulePath, reentry);
    case "resume":
      return cmdResume(io, store, rest[0], modulePath, reentry);
    case "stale":
      return cmdStale(io, store, rest[0]);
    case "report":
      return cmdReport(io, store, rest[0], out);
    case "verify":
      return cmdVerify(io, store, rest[0]);
    case "recheck":
      return cmdRecheck(io, store, rest[0], modulePath, only, allowIrreversible);
    case "export":
      return cmdExport(io, store, rest[0], out);
    case "import":
      return cmdImport(io, store, rest[0]);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      io.out(USAGE);
      return 0;
    default:
      io.err(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

function cmdLs(io: Io, store: RunStore): number {
  const ids = store.list();
  if (ids.length === 0) {
    io.out(dim(`no runs in ${store.dir}\n`));
    return 0;
  }
  const width = Math.max(...ids.map((id) => id.length));
  for (const id of ids) {
    try {
      const s = inspect(id, store);
      const cost = s.totals ? formatUsd(s.totals.billedUsd) : "-";
      const saved =
        s.totals && s.totals.savedUsd > 0 ? green(`  saved ${formatUsd(s.totals.savedUsd)}`) : "";
      const from = s.forkedFrom
        ? dim(
            `  ← ${s.forkedFrom.runId} @ ${
              s.forkedFrom.resumed ? "resumed" : (s.forkedFrom.atEffect ?? s.forkedFrom.atStep)
            }`,
          )
        : "";
      io.out(
        `${id.padEnd(width)}  ${padLabel(statusLabel(s.status), 16)}  ` +
          `${String(s.steps).padStart(2)} steps  ${cost.padStart(10)}${saved}${from}\n`,
      );
    } catch (cause) {
      io.out(`${id.padEnd(width)}  ${red("unreadable")}  ${describe(cause)}\n`);
    }
  }
  return 0;
}

function cmdShow(io: Io, store: RunStore, runId: string | undefined): number {
  if (!runId) return fail(io, "show needs a run id");
  const events = store.read(runId);
  const summary = inspect(runId, store);

  io.out(`${bold(runId)}  ${statusLabel(summary.status)}\n`);
  io.out(dim(`${summary.agent.name} · ${summary.agent.model} · via ${summary.provider}\n`));
  if (summary.forkedFrom) {
    const from = summary.forkedFrom;
    const set = from.overrides ?? [];
    const lineage = from.resumed
      ? `resumed from ${from.runId}, which stopped ${from.resumed.parentStatus} after ` +
        `${from.resumed.after} effect${from.resumed.after === 1 ? "" : "s"}`
      : `forked from ${from.runId} at ${forkPoint(from)}`;
    io.out(dim(`${lineage}${set.length > 0 ? `, with ${set.join(" and ")} set` : ""}\n`));
  }
  io.out(`\n${dim("input")}  ${truncate(summary.input, 200)}\n\n`);

  for (const event of events) printEvent(io, event);
  return 0;
}

/** One line per interesting event. Shared by `show` and the live re-run commands. */
function printEvent(io: Io, event: RetraceEvent): void {
  switch (event.type) {
    case "step.started":
      io.out(`${bold(`step ${event.step}`)}\n`);
      break;
    case "effect": {
      const tag = padLabel(event.replayed ? green("replayed") : yellow("live"), 9);
      const timing = event.replayed ? "" : dim(` ${event.durationMs}ms`);
      const moved = event.staleFacets ?? [];
      const stale = event.stale
        ? yellow(`  stale${moved.length > 0 ? ` (${moved.join(", ")})` : ""}`)
        : "";
      const set = event.overridden ? cyan("  set") : "";
      io.out(`  ${tag} ${event.kind.padEnd(6)} ${dim(event.key)}${timing}${set}${stale}\n`);
      if (event.failed) {
        io.out(`        ${red("threw")} ${truncate(event.failed.message, 120)}\n`);
        break;
      }
      if (event.kind === "tool") {
        const v = event.value as { content?: string; isError?: boolean };
        io.out(`        ${v.isError ? red("error") : dim("→")} ${truncate(v.content ?? "", 120)}\n`);
      }
      break;
    }
    case "message": {
      if (event.message.role !== "assistant") break;
      const said = textOf(event.message.content);
      if (said) io.out(`  ${dim("says")}  ${truncate(said, 200)}\n`);
      break;
    }
    case "run.finished":
      io.out(`\n${bold("finished")} ${statusLabel(event.status)}\n`);
      if (event.error) io.out(`  ${red(event.error)}\n`);
      io.out(`  ${totalsLine(event.totals)}\n`);
      break;
    default:
      break;
  }
}

function cmdCost(io: Io, store: RunStore, runId: string | undefined): number {
  if (!runId) return fail(io, "cost needs a run id");
  const events = store.read(runId);
  const charges = events.filter((e): e is Extract<RetraceEvent, { type: "charge" }> => e.type === "charge");
  const replayedSteps = new Set(
    effectsOf(events).filter((e) => e.kind === "model" && e.replayed).map((e) => e.step),
  );

  io.out(`${bold(runId)}\n\n`);
  io.out(dim("step   in      out     list price   billed\n"));
  for (const c of charges) {
    const marker = replayedSteps.has(c.step) ? green(" replayed") : "";
    io.out(
      `${String(c.step).padStart(4)}  ${String(c.usage.inputTokens).padStart(6)}  ` +
        `${String(c.usage.outputTokens).padStart(6)}  ${formatUsd(c.costUsd).padStart(11)}  ` +
        `${formatUsd(c.billedUsd).padStart(9)}${marker}\n`,
    );
  }

  const finished = events.find((e) => e.type === "run.finished");
  if (finished?.type === "run.finished") {
    io.out(`\n${totalsLine(finished.totals)}\n`);
  }
  return 0;
}

function cmdDiff(io: Io, store: RunStore, a: string | undefined, b: string | undefined): number {
  if (!a || !b) return fail(io, "diff needs two run ids");
  const cmp = compareRuns(a, b, store);

  io.out(`${bold(a)}  ${statusLabel(cmp.a.status)}  ${dim("·")}  ${bold(b)}  ${statusLabel(cmp.b.status)}\n`);
  for (const summary of [cmp.a, cmp.b]) {
    if (summary.forkedFrom) io.out(dim(`${summary.runId} ${origin(summary.forkedFrom)}\n`));
  }
  io.out("\n");

  // A run of shared effects is one fact however long it is, and printing a line
  // each buries the two or three that differ — which are the whole reason to
  // run this.
  for (const group of groupPairs(cmp.pairs)) {
    if (group.verdict === "same") {
      io.out(`${dim(span(group.from, group.to).padStart(7))} ${green("=")} ${dim(`${group.pairs.length} shared`)}\n`);
      continue;
    }
    for (const pair of group.pairs) {
      const left = pair.a ? `${pair.a.kind}:${pair.a.key}` : dim("(none)");
      io.out(
        `${String(pair.index).padStart(7)} ${red("≠")} ` +
          (pair.verdict === "value"
            ? `${left} ${dim("— same call, different result")}\n`
            : `${left} ${dim("|")} ${pair.b ? `${pair.b.kind}:${pair.b.key}` : dim("(none)")}\n`),
      );
    }
  }

  io.out(`\n${dim("free")}      ${freeLine(cmp)}\n`);
  io.out(
    `${dim("diverges")}  ` +
      (cmp.divergedAt === -1
        ? `nowhere: both logs hold the same ${cmp.pairs.length} effects\n`
        : `${yellow(`at effect ${cmp.divergedAt}`)}${divergenceNote(cmp)}\n`),
  );
  io.out(`${dim("ended")}     ${endedLine(cmp)}\n`);
  if (cmp.a.totals && cmp.b.totals) {
    io.out(
      `${dim("billed")}    ${formatUsd(cmp.a.totals.billedUsd)} ${dim("→")} ${formatUsd(cmp.b.totals.billedUsd)}\n`,
    );
  }

  if (cmp.contradiction !== undefined) {
    io.out(`\n${red("contradicted")}: ${cmp.contradiction}\n`);
    return 1;
  }
  return 0;
}

/** What the two logs owe each other, and whether they paid it. */
function freeLine(cmp: RunComparison): string {
  if (cmp.claimed === 0) {
    return dim(
      cmp.kinship.kind === "unrelated"
        ? "neither log names the other, or a run they both came from — nothing here has to match"
        : "neither run took anything out of a log, so both of them ran every effect they hold",
    );
  }
  const owed =
    cmp.kinship.kind === "siblings"
      ? `both replayed from ${cmp.kinship.origin}`
      : cmp.kinship.kind === "parent"
        ? `${cmp.kinship.parent === "a" ? cmp.b.runId : cmp.a.runId} replayed from ${cmp.kinship.parent === "a" ? cmp.a.runId : cmp.b.runId}`
        : "read twice";
  const held = `${plural(cmp.claimed, "effect")} ${owed}`;
  if (!cmp.ok) return red(held);
  return cmp.excused === 0
    ? `${green(held)}${dim(", value for value")}`
    : `${green(held)}${dim(`: ${cmp.claimed - cmp.excused} value for value, ${cmp.excused} substituted on purpose`)}`;
}

/**
 * Where the divergence sits relative to what the two runs were free to change.
 * Landing on the fork point is the fork doing exactly what it was told; landing
 * past it is live steps that reproduced the parent for a while first.
 */
function divergenceNote(cmp: RunComparison): string {
  if (cmp.claimed === 0) return "";
  if (cmp.divergedAt === cmp.claimed) return dim(", the first effect either run ran for itself");
  if (cmp.divergedAt > cmp.claimed) {
    return dim(`, ${plural(cmp.divergedAt - cmp.claimed, "effect")} past the last one replayed`);
  }
  const pair = cmp.pairs[cmp.divergedAt];
  return dim(
    pair?.a?.overridden === true || pair?.b?.overridden === true
      ? ", a value one of them was told to serve in place of the recorded one"
      : ", inside the prefix they share",
  );
}

function endedLine(cmp: RunComparison): string {
  const status =
    cmp.a.status === cmp.b.status
      ? `both ${statusLabel(cmp.a.status)}`
      : `${statusLabel(cmp.a.status)} ${dim("→")} ${statusLabel(cmp.b.status)}`;
  if (cmp.a.status !== "completed" || cmp.b.status !== "completed") return status;
  return `${status}${dim(cmp.a.output === cmp.b.output ? ", with the same answer" : ", with different answers")}`;
}

interface PairGroup {
  verdict: EffectPair["verdict"];
  from: number;
  to: number;
  pairs: EffectPair[];
}

/** Consecutive pairs that agree, collapsed; everything else one to a line. */
function groupPairs(pairs: readonly EffectPair[]): PairGroup[] {
  const groups: PairGroup[] = [];
  for (const pair of pairs) {
    const last = groups.at(-1);
    if (last?.verdict === "same" && pair.verdict === "same") {
      last.to = pair.index;
      last.pairs.push(pair);
      continue;
    }
    groups.push({ verdict: pair.verdict, from: pair.index, to: pair.index, pairs: [pair] });
  }
  return groups;
}

function span(from: number, to: number): string {
  return from === to ? String(from) : `${from}–${to}`;
}

/**
 * What the three commands that re-enter a recorded run share: what to serve in
 * place of the log, what to do when the log disagrees, and whether the live tail
 * may execute a tool that cannot be taken back.
 */
interface Reentry {
  overrides: Overrides;
  onDivergence: "strict" | "live" | undefined;
  allowIrreversible: boolean;
}

async function cmdReplay(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  { overrides, onDivergence, allowIrreversible }: Reentry,
): Promise<number> {
  if (!runId) return fail(io, "replay needs a run id");

  const parent = inspect(runId, store);
  const recorded = effectsOf(store.read(runId));
  const mod: RunModule = modulePath ? await loadRunModule(modulePath) : {};

  io.out(`${bold(runId)} ${dim(`→ replay of ${recorded.length} effects`)}\n`);
  io.out(dim(`${parent.agent.name} · ${parent.agent.model} · nothing here reaches the network\n\n`));

  const result = await replay(runId, {
    provider: mod.provider ?? LOG_ONLY,
    tools: mod.tools ?? [],
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    onEvent: (event) => printEvent(io, event),
  });

  const again = effectsOf(result.events);
  const divergedAt = firstDivergence(recorded, again);
  io.out(`\n${dim("new run")} ${result.runId}\n`);

  // A replay that was told to change a value is not claiming to reproduce
  // anything, so the comparison below would only ever report the change back.
  if (Object.keys(overrides).length > 0) {
    printOverridden(io, result.events);
    printStale(io, result.events);
    return 0;
  }

  if (divergedAt !== -1) {
    io.out(
      `${red("diverged")} at effect ${divergedAt}: recorded ${describeEffect(recorded[divergedAt])}, ` +
        `replayed ${describeEffect(again[divergedAt])}\n`,
    );
    return 1;
  }
  if (result.status !== parent.status) {
    io.out(
      `${red("differs")}: the same ${recorded.length} effects, but this run ended ` +
        `${statusLabel(result.status)} where the original ended ${statusLabel(parent.status)}\n`,
    );
    return 1;
  }
  if (result.output !== parent.output) {
    io.out(`${red("differs")}: the same ${recorded.length} effects, but a different output\n`);
    return 1;
  }
  io.out(
    `${green("reproduced")} ${recorded.length} effects, identical · ` +
      `${formatUsd(result.totals.savedUsd)} not spent\n`,
  );
  printStale(io, result.events);
  return 0;
}

/**
 * How much of what was replayed is answering a question this run no longer
 * asks. Worth a line rather than an exit code: in a fork it is the expected
 * consequence of forking, and in a replay run without `--module` it is the
 * honest description of a loop rebuilding its requests with no tools declared.
 */
function printStale(io: Io, events: readonly RetraceEvent[]): void {
  const stale = staleEffects(events);
  // A line each, because the two say different things. A stale model call is
  // the ordinary consequence of forking; a stale tool call means the input the
  // loop built for it moved, which only happens when something replaced the
  // model response above it.
  const said = {
    model: ["answers", "answer", "a request this run no longer builds"],
    tool: ["was", "were", "given the answer to a different call"],
  } as const;

  for (const kind of ["model", "tool"] as const) {
    const these = stale.filter((e) => e.kind === kind);
    if (these.length === 0) continue;
    const [one, many, rest] = said[kind];
    const moved = orderFacets(these.flatMap((e) => e.staleFacets ?? []));
    io.out(
      yellow(`${these.length} replayed ${kind} call${these.length === 1 ? "" : "s"} `) +
        dim(`${these.length === 1 ? one : many} ${rest}`) +
        // Which components moved is the actionable half: one you meant to change
        // is the fork working, and a second one beside it is a misconfiguration.
        dim(moved.length > 0 ? ` — ${moved.join(", ")} changed\n` : "\n"),
    );
  }
}

/** What the counterfactual actually replaced, once the run has been through it. */
function printOverridden(io: Io, events: readonly RetraceEvent[]): void {
  const set = overriddenEffects(events);
  if (set.length === 0) return;
  io.out(
    cyan(`${set.length} effect${set.length === 1 ? "" : "s"} served a value you set`) +
      dim(` instead of the recorded one: ${set.map((e) => e.key).join(", ")}\n`),
  );
}

async function cmdFork(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  atRaw: string | undefined,
  modulePath: string | undefined,
  { overrides, onDivergence, allowIrreversible }: Reentry,
): Promise<number> {
  if (!runId) return fail(io, "fork needs a run id");
  if (atRaw === undefined) {
    return fail(io, "fork needs --at <step|effect-key>: where it starts running live");
  }
  const at = readForkPoint(atRaw);
  if (at === undefined) {
    return fail(
      io,
      `--at takes a step number or an effect key, got "${atRaw}" — a key looks like ` +
        `"step:2#0:search", as show prints it`,
    );
  }
  if (modulePath === undefined) {
    return fail(io, "fork needs --module <path>: the live steps need tools and a provider");
  }

  const parent = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  const agent = { ...parent.agent, ...mod.agent };

  const [where, what] =
    at.atEffect === undefined
      ? [`step ${at.atStep}`, `steps below ${at.atStep} replay, ${at.atStep} onward runs live`]
      : [at.atEffect, `everything recorded before ${at.atEffect} replays, and it runs live`];
  io.out(`${bold(runId)} ${dim(`→ fork at ${where}`)}\n`);
  io.out(dim(`${agent.name} · ${agent.model} · ${what}\n\n`));

  const result = await fork(runId, {
    provider: mod.provider ?? (await anthropic()),
    ...at,
    tools: mod.tools ?? [],
    // Left undefined, each of these falls back to what the parent recorded.
    agent: mod.agent,
    input: mod.input,
    budget: mod.budget,
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    onEvent: (event) => printEvent(io, event),
  });

  io.out(`\n${dim("new run")} ${result.runId}\n`);
  if (result.totals.savedUsd > 0) {
    io.out(green(`the replayed prefix saved ${formatUsd(result.totals.savedUsd)}\n`));
  }
  printOverridden(io, result.events);
  printStale(io, result.events);
  return result.status === "failed" ? 1 : 0;
}

/**
 * Pick a run up where it stopped. The log replays whole and execution goes live
 * at the effect it ends on, so a run killed at step 9 of 12 costs nine steps
 * less to finish than starting it again.
 */
async function cmdResume(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  { overrides, onDivergence, allowIrreversible }: Reentry,
): Promise<number> {
  if (!runId) return fail(io, "resume needs a run id");
  if (modulePath === undefined) {
    return fail(io, "resume needs --module <path>: carrying on needs tools and a provider");
  }

  const parent = inspect(runId, store);
  const recorded = effectsOf(store.read(runId));
  const mod = await loadRunModule(modulePath);
  const agent = { ...parent.agent, ...mod.agent };

  io.out(`${bold(runId)} ${dim(`→ resume after ${recorded.length} recorded effects`)}\n`);
  io.out(
    dim(
      `${agent.name} · ${agent.model} · stopped ${parent.status}; the log replays, then it runs live\n\n`,
    ),
  );

  const result = await resume(runId, {
    provider: mod.provider ?? (await anthropic()),
    tools: mod.tools ?? [],
    // Left undefined, each of these falls back to what the parent recorded.
    agent: mod.agent,
    input: mod.input,
    budget: mod.budget,
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    onEvent: (event) => printEvent(io, event),
  });

  const effects = effectsOf(result.events);
  const live = effects.filter((e) => !e.replayed);
  io.out(`\n${dim("new run")} ${result.runId}\n`);

  if (live.length > 0) {
    io.out(
      `${green(`picked up at step ${live[0]!.step}`)}${dim(
        `: ${effects.length - live.length} effects replayed, ${live.length} ran live` +
          `${result.totals.savedUsd > 0 ? ` · saved ${formatUsd(result.totals.savedUsd)}` : ""}\n`,
      )}`,
    );
  } else if (result.status === "completed") {
    // The parent finished its work and died before writing that it had.
    io.out(
      `${green("nothing left to run")}${dim(
        ": the log already held the whole run, and it finished on replay\n",
      )}`,
    );
  } else {
    io.out(
      `${yellow("nothing ran live")}${dim(
        `: this run reached the end of the log and stopped ${result.status}, the way its ` +
          `parent did. Raise the limit it hit — maxSteps, or a budget — in the module.\n`,
      )}`,
    );
  }

  printOverridden(io, result.events);
  printStale(io, result.events);
  return result.status === "failed" ? 1 : 0;
}

/**
 * The other half of the `stale` marking every other command prints.
 *
 * `show`, `fork` and `replay` can say that a replayed step is answering an older
 * question, and which component of it moved, because that much is in the run's
 * own log. What it moved *to* is not — the log keeps a digest — and the answer
 * has always been sitting in the parent, which is the same log the free prefix
 * came out of. This reads both and says it. Nothing executes, so it is a
 * description rather than a check, and it exits zero either way.
 */
function cmdStale(io: Io, store: RunStore, runId: string | undefined): number {
  if (!runId) return fail(io, "stale needs a run id");

  const summary = inspect(runId, store);
  const report = explainStale(runId, store);

  io.out(`${bold(runId)}  ${statusLabel(summary.status)}\n`);
  if (summary.forkedFrom) io.out(dim(`${origin(summary.forkedFrom)}\n`));
  io.out("\n");

  if (report.staleEffects === 0) {
    io.out(
      `${green("nothing stale")}${dim(
        ": every effect this run served from the log was recorded against the request it builds\n",
      )}`,
    );
    return 0;
  }

  for (const change of report.changes) {
    io.out(`${bold(change.facet)}${change.where ? dim(` · ${change.where}`) : ""}\n`);
    io.out(`  ${dim(change.keys.join(", "))}\n`);
    io.out(`  ${red(`- ${truncate(change.before, 160)}`)}\n`);
    io.out(`  ${green(`+ ${truncate(change.after, 160)}`)}\n\n`);
  }
  for (const gap of report.unexplained) {
    io.out(`${bold(gap.facet)}\n`);
    io.out(`  ${dim(gap.keys.join(", "))}\n`);
    io.out(`  ${yellow(`? ${gap.why}`)}\n\n`);
  }

  const effects = plural(report.staleEffects, "stale effect");
  if (report.complete) {
    io.out(
      `${green("explained")}: ${effects}, and ${plural(report.changes.length, "change")} ` +
        `${report.changes.length === 1 ? "is" : "are"} the whole of what moved under ` +
        `${report.staleEffects === 1 ? "it" : "them"}\n`,
    );
    return 0;
  }
  io.out(
    `${yellow("explained as far as the logs go")}: ${effects}, ` +
      `${plural(report.changes.length, "change")} named and ` +
      `${plural(report.unexplained.length, "component")} the logs cannot account for\n`,
  );
  return 0;
}

/**
 * The log as a page you can send someone. Everything comes out of the log, so
 * this reaches neither the network nor a module — a report of a run recorded on
 * another machine renders exactly the same here.
 */
function cmdReport(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  out: string | undefined,
): number {
  if (!runId) return fail(io, "report needs a run id");

  const events = store.read(runId);
  const summary = summarize(runId, events);
  const html = renderReport(summary, events);

  if (out === "-") {
    io.out(html);
    return 0;
  }

  const path = out ?? `${runId}.html`;
  writeFileSync(path, html, "utf8");

  const effects = effectsOf(events);
  const replayed = effects.filter((e) => e.replayed).length;
  io.out(`${bold(runId)} ${dim("→")} ${path}\n`);
  io.out(
    dim(
      `${summary.steps} steps · ${effects.length} effects` +
        `${replayed > 0 ? `, ${replayed} replayed` : ""} · ${(html.length / 1024).toFixed(0)}KB, no external assets\n`,
    ),
  );
  return 0;
}

/**
 * Reads logs and executes nothing, so it says the same thing about a run
 * wherever that run is read — which is the only way the claim is worth
 * anything. Exits non-zero on a failed check so it can gate a pipeline.
 */
function cmdVerify(io: Io, store: RunStore, runId: string | undefined): number {
  if (!runId) return fail(io, "verify needs a run id");

  const summary = inspect(runId, store);
  const report = verifyRun(runId, store);

  io.out(`${bold(runId)}  ${statusLabel(summary.status)}\n`);
  if (summary.forkedFrom) io.out(dim(`${origin(summary.forkedFrom)}\n`));
  io.out("\n");

  const width = Math.max(...report.checks.map((c) => c.name.length));
  for (const check of report.checks) {
    const mark =
      check.status === "ok" ? green("ok  ") : check.status === "failed" ? red("fail") : dim("--  ");
    const detail = check.status === "failed" ? check.detail : dim(check.detail);
    io.out(`  ${mark} ${check.name.padEnd(width)}  ${detail}\n`);
  }

  if (!report.ok) {
    const broken = report.checks.filter((c) => c.status === "failed").map((c) => c.name);
    io.out(`\n${red("unverified")}: ${broken.join(", ")}\n`);
    return 1;
  }
  if (report.complete) {
    io.out(`\n${green("verified")}: this log holds up against everything it claims\n`);
    return 0;
  }
  const short = report.checks.filter((c) => c.status === "skipped").length;
  io.out(
    `\n${yellow("verified as far as it goes")}: ` +
      `${short} check${short === 1 ? "" : "s"} had nothing to run against\n`,
  );
  return 0;
}

/**
 * What `verify` needs and a single log cannot carry: the runs a fork's free
 * prefix is owed to. Collected here where they exist, so the lineage check runs
 * whole on a machine that has never seen them.
 */
function cmdExport(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  out: string | undefined,
): number {
  if (!runId) return fail(io, "export needs a run id");

  const bundle = collectBundle(runId, store);
  const text = serializeBundle(bundle);
  if (out === "-") {
    io.out(text);
    return 0;
  }

  const path = out ?? `${runId}.bundle.jsonl`;
  writeFileSync(path, text, "utf8");

  const events = bundle.runs.reduce((n, r) => n + r.events.length, 0);
  const ancestors = bundle.runs.length - 1;
  io.out(`${bold(runId)} ${dim("→")} ${path}\n`);
  io.out(
    dim(
      `${plural(bundle.runs.length, "run")}, ${plural(events, "event")}, ` +
        `${(text.length / 1024).toFixed(0)}KB\n`,
    ),
  );

  if (!bundle.complete) {
    io.out(
      yellow(
        `the chain stops short: ${bundle.incomplete} — a verify of this bundle traces its ` +
          `lineage that far and reports the rest skipped, exactly as one here would\n`,
      ),
    );
    return 0;
  }
  io.out(
    green(
      ancestors === 0
        ? "this run was forked from nothing, so the bundle is the whole of its lineage\n"
        : `${plural(ancestors, "run")} of lineage, back to a run forked from nothing — ` +
            `verify runs complete wherever this lands\n`,
    ),
  );
  return 0;
}

/**
 * The other end of `export`. A run already here is left as it is if it matches
 * and refused if it does not: a bundle that could overwrite a log would be a way
 * to doctor the very history `verify` reads.
 */
function cmdImport(io: Io, store: RunStore, path: string | undefined): number {
  if (!path) return fail(io, "import needs the path to a bundle");

  const report = importBundle(parseBundle(readFileSync(path, "utf8")), store);
  const held = report.added.length + report.present.length;

  io.out(`${bold(path)} ${dim("→")} ${store.dir}\n`);
  io.out(
    dim(
      `${plural(held, "run")}: ` +
        (report.added.length === 0 ? "none new" : `added ${report.added.join(", ")}`) +
        (report.present.length === 0 ? "" : `; already here ${report.present.join(", ")}`) +
        "\n",
    ),
  );
  if (!report.complete) {
    io.out(yellow(`the lineage in it stops short: ${report.incomplete}\n`));
  }
  io.out(dim(`${cyan(`retrace verify ${report.root}`)} now has the runs it needs\n`));
  return 0;
}

/**
 * The other half of `verify`. That one holds a log to itself and never executes;
 * this one executes and holds it to the world, which is the only way to find out
 * whether a prefix worth replaying is still a prefix worth believing.
 */
async function cmdRecheck(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  only: readonly string[],
  allowIrreversible: boolean,
): Promise<number> {
  if (!runId) return fail(io, "recheck needs a run id");
  if (modulePath === undefined) {
    return fail(io, "recheck needs --module <path>: it has to execute the tools to compare them");
  }

  const summary = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  const report = await recheckRun(runId, {
    tools: mod.tools ?? [],
    store,
    ...(only.length > 0 ? { only } : {}),
    ...(allowIrreversible ? { allowIrreversible } : {}),
  });

  const total = report.calls.length;
  io.out(`${bold(runId)}  ${statusLabel(summary.status)}\n`);
  io.out(
    dim(
      `${summary.agent.name} · ${summary.agent.model} · ` +
        `${total} recorded tool call${total === 1 ? "" : "s"}\n\n`,
    ),
  );

  if (total === 0) {
    io.out(dim("this run records no tool calls, so there is nothing to ask again\n"));
    return 0;
  }

  const width = Math.max(...report.calls.map((c) => c.key.length));
  for (const call of report.calls) {
    const label = RECHECK_LABELS[call.status].padEnd(MARK_WIDTH);
    const mark =
      call.status === "same"
        ? green(label)
        : call.status === "moved" || call.status === "unstable"
          ? red(label)
          : dim(label);
    io.out(`  ${mark} ${call.key.padEnd(width)}  ${dim(truncate(JSON.stringify(call.input), 60))}\n`);
    if (call.now && (call.status === "moved" || call.status === "unstable")) {
      // Under the input column: the question, then the answers to it. An
      // unstable call gets a second `now` rather than a new label, because both
      // of them are what it says now and that they differ is the finding. A
      // moved one was asked twice too, and agreed with itself both times —
      // printing that agreement twice would say nothing.
      const indent = " ".repeat(width + MARK_WIDTH + 5);
      const said = (label: string, value: string, paint = (s: string) => s): void =>
        io.out(`${indent}${dim(label)}  ${paint(truncate(value, 90))}\n`);
      said("was", call.recorded.content);
      said("now", call.now.content, cyan);
      if (call.status === "unstable" && call.again) said("now", call.again.content, cyan);
    }
  }

  const unstable = report.calls.filter((c) => c.status === "unstable").length;
  const moved = report.calls.filter((c) => c.status === "moved").length;
  const ran = report.calls.filter(executed).length;
  io.out("\n");

  if (unstable > 0) {
    io.out(
      `${red("unstable")}: ${unstable} of ${ran} re-executed tool call${ran === 1 ? "" : "s"} ` +
        `did not give the same answer twice — ${unstable === 1 ? "it reads" : "they read"} ` +
        `something the journal does not cover, so what the log holds is a snapshot rather than ` +
        `an answer a fork could replay\n`,
    );
  }
  if (moved > 0) {
    io.out(
      `${red("moved")}: ${moved} of ${ran} re-executed tool call${ran === 1 ? "" : "s"} no longer ` +
        `return${moved === 1 ? "s" : ""} what the log holds — a fork off this run replays an ` +
        `answer the world has since changed\n`,
    );
  }
  if (unstable > 0 || moved > 0) return 1;
  if (report.complete) {
    io.out(
      `${green("still true")}: all ${ran} recorded tool call${ran === 1 ? "" : "s"} ` +
        `${ran === 1 ? "returns" : "return"} what the log holds\n`,
    );
    return 0;
  }
  io.out(
    `${yellow("still true as far as it goes")}: ${ran} of ${total} recorded tool calls ` +
      `re-executed and agreed; ${describeUnrun(report)}\n`,
  );
  return 0;
}

/**
 * What each outcome is called in the timeline. `set` is deliberately the word
 * the report and `show` already use for a substituted value, since it is the
 * same fact arriving from a different direction.
 */
const RECHECK_LABELS: Record<RecheckStatus, string> = {
  same: "same",
  moved: "moved",
  unstable: "unstable",
  substituted: "set",
  missing: "no tool",
  irreversible: "held",
  skipped: "skipped",
};

const MARK_WIDTH = Math.max(...Object.values(RECHECK_LABELS).map((l) => l.length));

/** Why the calls that were not executed were not executed, counted by reason. */
function describeUnrun(report: RecheckReport): string {
  const reasons: Array<[RecheckStatus, string]> = [
    ["missing", "name a tool the module does not export"],
    ["irreversible", "call a tool marked irreversible, which was held back rather than repeated"],
    ["skipped", "were not asked for"],
    ["substituted", "hold a value that was substituted rather than returned"],
  ];
  return reasons
    .map(([status, why]): string => {
      const n = report.calls.filter((c) => c.status === status).length;
      return n === 0 ? "" : `${n} ${why}`;
    })
    .filter((s) => s !== "")
    .join(", ");
}

/** Where a re-entered run came from, in the words of the command that made it. */
function origin(from: ForkOrigin): string {
  if (from.resumed) {
    return `picked up from ${from.runId}, which stopped ${statusLabel(from.resumed.parentStatus)} after ${from.resumed.after} effects`;
  }
  return from.atStep === "all"
    ? `replayed from ${from.runId} in full`
    : `forked from ${from.runId} at ${forkPoint(from)}`;
}

/**
 * The fork point in the words of the command that asked for it: a step, or the
 * effect within it when the fork was told to re-enter mid-step.
 */
function forkPoint(from: ForkOrigin): string {
  return from.atEffect ?? `step ${from.atStep}`;
}

/**
 * Stands in for a provider when `replay` is given no module. Reaching it means
 * the log ran out before the run did, which is worth an error rather than a
 * network call the user never asked for.
 */
const LOG_ONLY: Provider = {
  name: "log-only",
  complete() {
    throw new Error(
      "replay needed a live model call: the log is shorter than the run it recorded. " +
        "Pass --module <path> exporting a provider to carry on past the end of the log.",
    );
  },
};

/** Imported on demand: `ls` and `show` have no reason to load the SDK. */
async function anthropic(): Promise<Provider> {
  const { AnthropicProvider } = await import("./providers/anthropic.ts");
  return new AnthropicProvider();
}

/** Index of the first effect two runs don't share, or -1 when they match. */
function firstDivergence(left: readonly Effect[], right: readonly Effect[]): number {
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    if (!sameEffect(left[i], right[i])) return i;
  }
  return -1;
}

function sameEffect(l: Effect | undefined, r: Effect | undefined): boolean {
  return (
    l !== undefined &&
    r !== undefined &&
    l.kind === r.kind &&
    l.key === r.key &&
    JSON.stringify(l.value) === JSON.stringify(r.value) &&
    // A throw is an outcome: a replay that reproduces the failure matches, and
    // one that quietly succeeded where the log records a failure does not.
    JSON.stringify(l.failed) === JSON.stringify(r.failed)
  );
}

function describeEffect(effect: Effect | undefined): string {
  return effect ? `${effect.kind}:${effect.key}` : "nothing";
}

/** Pull `--name value` out of the argument list, leaving the positionals behind. */
function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  args.splice(at, 2);
  return value;
}

/** An option with no value: present or not. */
function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

/** The same, for an option that may be given more than once. */
function takeEvery(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let value = takeOption(args, name); value !== undefined; value = takeOption(args, name)) {
    values.push(value);
  }
  return values;
}

/**
 * `--set <effect-key>=<value>`. The value is read as JSON where it parses as
 * JSON, so a recorded number or object can be replaced with one, and taken as
 * plain text where it doesn't — which is what a tool result usually is.
 */
function readOverrides(pairs: readonly string[]): Overrides {
  const overrides: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new Error(`--set takes "<effect-key>=<value>", got "${pair}"`);
    }
    const raw = pair.slice(at + 1);
    try {
      overrides[pair.slice(0, at)] = JSON.parse(raw);
    } catch {
      overrides[pair.slice(0, at)] = raw;
    }
  }
  return overrides;
}

/**
 * `--at` takes either kind of fork point. A step is a number; an effect is the
 * key `show` prints, which always carries a colon, so the two can't be mistaken
 * for one another and anything that is neither is a typo worth naming.
 */
function readForkPoint(raw: string): ForkPoint | undefined {
  const atStep = Number(raw);
  if (Number.isInteger(atStep) && atStep >= 0) return { atStep };
  return raw.includes(":") ? { atEffect: raw } : undefined;
}

function readPolicy(value: string | undefined): "strict" | "live" | undefined {
  if (value === undefined || value === "strict" || value === "live") return value;
  throw new Error(`--on-divergence takes "strict" or "live", got "${value}"`);
}

function totalsLine(t: {
  steps: number;
  toolCalls: number;
  costUsd: number;
  billedUsd: number;
  savedUsd: number;
  wallClockMs: number;
}): string {
  const saved = t.savedUsd > 0 ? green(`  saved ${formatUsd(t.savedUsd)}`) : "";
  return (
    `${t.steps} steps · ${t.toolCalls} tool calls · ${(t.wallClockMs / 1000).toFixed(1)}s · ` +
    `list ${formatUsd(t.costUsd)} · billed ${formatUsd(t.billedUsd)}${saved}`
  );
}

/** Pad to a visible width, ignoring the ANSI escapes that carry no columns. */
function padLabel(label: string, width: number): string {
  const visible = label.replace(/\x1b\[[0-9;]*m/g, "").length;
  return label + " ".repeat(Math.max(0, width - visible));
}

function statusLabel(status: string): string {
  if (status === "completed") return green(status);
  if (status === "running") return dim(status);
  if (status === "budget_exceeded" || status === "max_steps") return yellow(status);
  return red(status);
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function fail(io: Io, message: string): number {
  io.err(`${message}\n\n${USAGE}`);
  return 1;
}

// npm installs the bin as a symlink in node_modules/.bin, and Node reports the
// link in argv[1] while import.meta.url is already the file behind it. Compared
// unresolved, the two never match and the installed command exits having done
// nothing at all.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
