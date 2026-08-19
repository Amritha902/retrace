#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ablateRun, DROPPED, type AblationControl, type AblationTrial } from "./ablate.ts";
import { orderFacets } from "./agent.ts";
import { collectBundle, importBundle, parseBundle, serializeBundle } from "./bundle.ts";
import { compareRuns, type EffectPair, type RunComparison } from "./compare.ts";
import { explainStale } from "./explain.ts";
import { describeFetch, type RecordedFetch } from "./http.ts";
import { loadRunModule, type RunModule } from "./module.ts";
import { planFork } from "./plan.ts";
import { formatUsd } from "./pricing.ts";
import { describeRead, type RecordedRead } from "./read.ts";
import type { Overrides } from "./journal.ts";
import {
  ambientEffects,
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
import {
  executed,
  recheckRun,
  recordedToolCalls,
  type RecheckReport,
  type RecheckStatus,
} from "./recheck.ts";
import { renderReport } from "./report.ts";
import { searchForkPoints } from "./search.ts";
import { DEFAULT_STORE_DIR, RunStore } from "./store.ts";
import { sweepForkPoint, type SweepTrial } from "./sweep.ts";
import { lineageTrees, type TreeRun } from "./tree.ts";
import { verifyRun } from "./verify.ts";
import type { ContentBlock, ForkOrigin, Provider, RetraceEvent } from "./types.ts";

const USAGE = `retrace — inspect and re-run recorded agent runs

  retrace ls                    list runs, newest last
  retrace tree [run-id]         the runs made from a run, and what each asked
                                that the run above it didn't
  retrace show <run-id>         print the run's timeline
  retrace cost <run-id>         per-step spend, and what replay saved
  retrace diff <run-a> <run-b>  where two runs stopped agreeing, whether they
                                were asking the same thing there, and whether
                                they agree everywhere they had to
  retrace replay <run-id>       re-run it from the log, and check it reproduces
  retrace fork <run-id> --at N  replay the steps below N, then run live
                                (--at <effect-key> re-enters mid-step instead)
  retrace plan <run-id> --at N  what that fork would replay, save and go stale
                                on, before any of it is paid for
  retrace search <run-id>       fork downward until a change takes, and say at
                                which step it did and what the search cost
  retrace sweep <run-id> --at N try several changes at one fork point, off one
                                replayed prefix, and put the answers side by side
  retrace ablate <run-id>       drop each recorded tool answer in turn, and say
                                which of them the run's conclusion needed
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
                            call itself — "step:2#1:search". For search it is
                            the first, highest fork point tried
  --until <pattern>         what search is looking for: a regular expression the
                            fork's answer must match. Without it, search stops
                            at the first fork point whose answer is not the
                            recorded one
  --down-to <n>             the lowest fork point search may try (default 0)
  --max-forks <n>           give up after this many forks, whatever --down-to
                            says. Caps ablate's forks the same way
  --instead <text>          what ablate serves in place of a dropped answer
                            (default "${DROPPED}"). The counterfactual it asks
                            is "what if the call had said this"
  --repeat <n>              cut each of search's fork points n times instead of
                            once (default 1). A fork point holds only if every
                            fork made at it answers the same way, so a model
                            that would have moved the answer on its own comes
                            back "unstable" rather than as a change taking
  -o, --out <path>          where report writes its HTML or export its bundle;
                            "-" for stdout (default: <run-id>.html, and
                            <run-id>.bundle.jsonl)
  --module <path>           module exporting the live half of the run — tools,
                            a provider, and agent fields to override. Required
                            by fork and resume; replay only needs it to go past
                            the log. For sweep it also exports "arms", the
                            variations to try at the fork point
  --set <key>=<value>       serve <value> in place of the effect recorded under
                            <key>, as show prints it — "step:2#0:search=nothing
                            found". Repeatable; the key must be below --at.
  --on-divergence <policy>  strict (default) stops when the log disagrees with
                            the loop; live executes from that point instead
  --tool <name>             limit recheck and ablate to this tool. Repeatable.
                            What recheck runs, it runs for real — this is how
                            you keep it away from a tool that writes something.
                            A call that disagrees with the log is run a second
                            time, to tell a moved corpus from a tool with no
                            settled answer. For ablate it picks which recorded
                            answers are dropped
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
  const instead = takeOption(args, "--instead");
  const until = takeOption(args, "--until");
  const downTo = readCount(takeOption(args, "--down-to"), "--down-to");
  const maxForks = readCount(takeOption(args, "--max-forks"), "--max-forks");
  const repeat = readCount(takeOption(args, "--repeat"), "--repeat");
  const allowIrreversible = takeFlag(args, "--allow-irreversible");
  const reentry: Reentry = { overrides, onDivergence, allowIrreversible };

  const [command, ...rest] = args;
  const store = new RunStore(dir);

  switch (command) {
    case "ls":
      return cmdLs(io, store);
    case "tree":
      return cmdTree(io, store, rest[0]);
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
    case "plan":
      return cmdPlan(io, store, rest[0], atRaw, modulePath, reentry);
    case "search":
      return cmdSearch(io, store, rest[0], modulePath, reentry, {
        atRaw,
        until,
        downTo,
        maxForks,
        repeat,
      });
    case "sweep":
      return cmdSweep(io, store, rest[0], atRaw, modulePath, reentry);
    case "ablate":
      return cmdAblate(io, store, rest[0], modulePath, reentry, { only, instead, maxForks });
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

function cmdTree(io: Io, store: RunStore, runId: string | undefined): number {
  const forest = lineageTrees(store, runId);
  if (forest.trees.length === 0) {
    io.out(dim(`no runs in ${store.dir}\n`));
    return 0;
  }

  let runs = 0;
  let billed = 0;
  let saved = 0;
  for (const tree of forest.trees) {
    io.out("\n");
    // Above the root there is a run this store does not hold, which is why the
    // family starts here rather than where the lineage does.
    if (tree.before) io.out(dim(`↑ ${tree.before}, which is not in this store\n`));
    printRun(io, tree.root, "", true, true, runId);
    runs += tree.runs;
    billed += tree.billedUsd;
    saved += tree.savedUsd;
  }

  const free = saved > 0 ? ` · ${green(`${formatUsd(saved)} not paid a second time`)}` : "";
  io.out(`\n${plural(runs, "run")} · ${formatUsd(billed)} billed${free}\n`);
  if (forest.unreadable.length > 0) {
    io.out(
      red(
        `${plural(forest.unreadable.length, "run")} could not be read, so ` +
          `${forest.unreadable.length === 1 ? "it belongs" : "they belong"} to no family here: ` +
          `${forest.unreadable.join(", ")}\n`,
      ),
    );
  }
  return 0;
}

/** One run of a family, then the runs made from it, indented under it. */
function printRun(
  io: Io,
  node: TreeRun,
  prefix: string,
  last: boolean,
  root: boolean,
  marked: string | undefined,
): void {
  const connector = root ? "" : last ? "└─ " : "├─ ";
  const under = prefix + (root ? "" : last ? "   " : "│  ");
  const detail = `${under}  `;
  const id = node.runId === marked ? bold(node.runId) : node.runId;

  io.out(`${prefix}${connector}${id}  ${statusLabel(node.summary.status)}  ${dim(asked(node))}\n`);
  io.out(`${detail}${dim(spend(node))}\n`);
  const said = node.summary.error
    ? red(node.summary.error)
    : node.summary.output || dim("no answer");
  io.out(`${detail}${truncate(said, 76)}\n`);

  node.children.forEach((child, i) =>
    printRun(io, child, under, i === node.children.length - 1, false, marked),
  );
}

/** What this run was asking that the run above it wasn't. */
function asked(node: TreeRun): string {
  const parts: string[] = [];
  if (node.reentry?.kind === "fork") parts.push(`fork at ${node.reentry.at}`);
  if (node.reentry?.kind === "replay") parts.push("replay");
  if (node.reentry?.kind === "resume") {
    parts.push(`resume after ${plural(node.reentry.after, "effect")}`);
  }
  if (node.set.length > 0) parts.push(`set ${node.set.join(", ")}`);
  if (node.moved.length > 0) parts.push(node.moved.join(", "));
  return parts.join(" · ") || "recorded from scratch";
}

function spend(node: TreeRun): string {
  const t = node.summary.totals;
  if (!t) return `${plural(node.summary.steps, "step")} · still running, or stopped without totals`;
  const free = t.savedUsd > 0 ? ` · ${formatUsd(t.savedUsd)} free` : "";
  return `${plural(t.steps, "step")} · ${formatUsd(t.billedUsd)} billed${free}`;
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
      const read = event.ambient?.length ? red(`  reads ${event.ambient.join(", ")}`) : "";
      io.out(`  ${tag} ${event.kind.padEnd(6)} ${dim(event.key)}${timing}${set}${stale}${read}\n`);
      if (event.failed) {
        io.out(`        ${red("threw")} ${truncate(event.failed.message, 120)}\n`);
        break;
      }
      if (event.kind === "tool") {
        const v = event.value as { content?: string; isError?: boolean };
        io.out(`        ${v.isError ? red("error") : dim("→")} ${truncate(v.content ?? "", 120)}\n`);
      }
      // The key of a fetch or a read carries a digest of what was asked rather
      // than the thing itself, so the line above says which slot and not what
      // the question was.
      if (event.kind === "fetch") {
        io.out(`        ${dim("→")} ${truncate(describeFetch(event.value as RecordedFetch), 120)}\n`);
      }
      if (event.kind === "read") {
        io.out(`        ${dim("→")} ${truncate(describeRead(event.value as RecordedRead), 120)}\n`);
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
            ? `${left} ${dim(`— ${valueNote(pair)}`)}\n`
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
  // Where the two parted on one call rather than on the shape of the run, the
  // question that call was asked is the next thing a reader wants, and the two
  // logs recorded it. See `askedOf`.
  const diverged = cmp.divergedAt === -1 ? undefined : cmp.pairs[cmp.divergedAt];
  if (diverged?.asked !== undefined) io.out(`${dim("asked")}     ${askedLine(diverged)}\n`);
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

/** One position the two runs answered differently, in the effect list. */
function valueNote(pair: EffectPair): string {
  if (pair.a?.overridden === true || pair.b?.overridden === true) {
    return "same call, a value one of them was told to serve";
  }
  switch (pair.asked?.kind) {
    case "moved":
      return pair.asked.facets.length === 0
        ? "same call, asked something else"
        : `same call, asked something else — ${pair.asked.facets.join(", ")}`;
    case "same":
      return "same call, same question, different answer";
    default:
      return "same call, different result";
  }
}

/**
 * The same reading as a claim about the run, under the effect list. This is the
 * line that separates a fork doing what you asked from two runs that parted on
 * something neither of them changed.
 */
function askedLine(pair: EffectPair): string {
  const asked = pair.asked;
  const indent = " ".repeat(10);
  switch (asked?.kind) {
    case "moved":
      return asked.facets.length === 0
        ? dim("a different question there, and neither log says which part of it moved")
        : `${yellow("a different question there")}${dim(` — ${asked.facets.join(", ")}`)}`;
    case "same":
      return (
        `${yellow("the same question there, answered differently")}\n` +
        dim(`${indent}${unaccounted(pair.a?.kind)}`)
      );
    default:
      return dim(`not something these two logs settle: ${asked?.why ?? ""}`);
  }
}

/** What answers one question two ways, by the kind of call that was asked it. */
function unaccounted(kind: string | undefined): string {
  switch (kind) {
    case "model":
      return "the provider answered one request two ways — nothing either log holds accounts for it";
    case "tool":
      return "the tool answered one input two ways — it reads something the journal does not cover, or the world moved under it";
    case "fetch":
      return "the network answered one request two ways — the world moved between the runs";
    case "read":
      return "the source answered one question two ways — the world moved between the runs";
    default:
      return "nothing either log holds accounts for it";
  }
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
    printAmbient(io, result.events);
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
  printAmbient(io, result.events);
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

/**
 * The tool calls in this run that took a time, an id or a random draw from
 * somewhere the journal cannot follow.
 *
 * The other two lines describe a prefix that is answering an older question;
 * this one describes a prefix that is not an answer at all, because the tool
 * would not say it again. It is printed after them for that reason — it is the
 * one of the three that is a problem rather than a consequence.
 */
function printAmbient(io: Io, events: readonly RetraceEvent[]): void {
  const reached = ambientEffects(events);
  if (reached.length === 0) return;
  const sources = [...new Set(reached.flatMap((e) => e.ambient ?? []))];
  io.out(
    red(`${reached.length} tool call${reached.length === 1 ? "" : "s"} read the `) +
      red(`${sources.join(" and ")} outside the journal`) +
      dim(`: ${reached.map((e) => e.key).join(", ")}\n`) +
      dim(`  what the log holds for ${reached.length === 1 ? "it" : "them"} is a snapshot, `) +
      dim(`not something a replay reproduces — take these from ctx instead\n`),
  );
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
  printAmbient(io, result.events);
  return result.status === "failed" ? 1 : 0;
}

/**
 * The fork, described rather than made.
 *
 * `fork` tells you what a replayed prefix was still answering *after* it has run
 * a live step to find out. Everything in that answer — the cut, the requests the
 * prefix would be built against, the tools the module declares, the calls the
 * fork point's own step would repeat — is in the log and the module beforehand.
 * This says it beforehand, and executes nothing to do it.
 */
async function cmdPlan(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  atRaw: string | undefined,
  modulePath: string | undefined,
  { overrides, allowIrreversible }: Reentry,
): Promise<number> {
  if (!runId) return fail(io, "plan needs a run id");
  if (atRaw === undefined) {
    return fail(io, "plan needs --at <step|effect-key>: the fork point it describes");
  }
  const at = readForkPoint(atRaw);
  if (at === undefined) {
    return fail(
      io,
      `--at takes a step number or an effect key, got "${atRaw}" — a key looks like ` +
        `"step:2#0:search", as show prints it`,
    );
  }

  const mod: RunModule = modulePath ? await loadRunModule(modulePath) : {};
  const plan = planFork(runId, {
    ...at,
    // Absent rather than empty when there is no module: without the tools the
    // fork would declare, what its prefix would be answering is not knowable,
    // and the plan says so instead of reporting every step stale.
    ...(mod.tools === undefined ? {} : { tools: mod.tools }),
    agent: mod.agent,
    input: mod.input,
    overrides,
    allowIrreversible,
    store,
  });

  io.out(`${bold(runId)}  ${statusLabel(plan.status)}\n`);
  io.out(
    dim(
      `${plan.agent.name} · ${plan.agent.model} · fork at ${plan.atEffect ?? `step ${plan.atStep}`}\n\n`,
    ),
  );

  const line = (label: string, text: string): void =>
    io.out(`  ${padLabel(label, 9)} ${text}\n`);

  line(
    green("replays"),
    `${plan.replayed} of ${plural(plan.recorded, "effect")}` +
      `${plan.replayedSteps > 0 ? `, ${plural(plan.replayedSteps, "step")} whole` : ""}` +
      dim(` · ${formatUsd(plan.savedUsd)} of ${formatUsd(plan.costUsd)} not spent again`),
  );
  line(
    yellow("live"),
    plan.atEffect === undefined
      ? dim(`step ${plan.atStep} onward: the model call, and whatever it asks for`)
      : dim(
          `${plan.atEffect} onward: ${plural(plan.live.length, "recorded tool call")}` +
            `, then whatever the step after it asks for`,
        ),
  );

  if (plan.blocked !== undefined) {
    line(dim("stale"), dim(plan.blocked));
  } else if (plan.stale.length === 0) {
    line(green("stale"), dim("nothing: the prefix answers the requests this fork would build"));
  } else {
    for (const kind of ["model", "tool"] as const) {
      const these = plan.stale.filter((s) => s.kind === kind);
      if (these.length === 0) continue;
      const moved = orderFacets(these.flatMap((s) => s.facets));
      line(
        yellow("stale"),
        `${plural(these.length, `replayed ${kind} call`)} ` +
          dim(
            kind === "model"
              ? "would answer a request this fork no longer builds"
              : "would be given the answer to a different call",
          ) +
          // Which components moved is the actionable half, exactly as it is
          // after a fork: one you meant to change is the fork working, and a
          // second one beside it is a module that is not the run's.
          dim(moved.length > 0 ? ` — ${moved.join(", ")}` : ""),
      );
      line("", dim(these.map((s) => s.key).join(", ")));
    }
  }
  if (plan.undigested > 0) {
    line(dim("undigested"), dim(`${plural(plan.undigested, "call")} carries no request digest`));
  }
  if (plan.undeclared.length > 0) {
    line(
      yellow("tools"),
      `the log declares ${plan.undeclared.map((n) => `"${n}"`).join(", ")}` +
        dim(", and this module does not — a live step that asks for one would fail"),
    );
  }
  for (const call of plan.held) {
    line(
      red("held"),
      `"${call.tool}" at ${call.key} is marked irreversible` +
        dim(" — this fork would stop there rather than make the call again"),
    );
  }

  io.out(
    plan.held.length > 0
      ? `\n${red("would not run")}: fork above ${plan.held[0]!.key} to replay it instead, or pass --allow-irreversible\n`
      : `\n${dim("nothing ran: this is the fork read off the log, before you pay for it")}\n`,
  );
  return plan.held.length > 0 ? 1 : 0;
}

/**
 * How far down a change has to go, found by going there.
 *
 * `fork` answers one fork point at a time, and the question a person is usually
 * asking across several of them is which one they needed. Walking downward is
 * what makes that cheap: the highest fork point has the most of the run already
 * paid for, so the search spends least on the answer it is most likely to want,
 * and stops the moment one holds.
 */
async function cmdSearch(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  { overrides, onDivergence, allowIrreversible }: Reentry,
  bounds: {
    atRaw: string | undefined;
    until: string | undefined;
    downTo: number | undefined;
    maxForks: number | undefined;
    repeat: number | undefined;
  },
): Promise<number> {
  if (!runId) return fail(io, "search needs a run id");
  if (modulePath === undefined) {
    return fail(io, "search needs --module <path>: every fork it makes runs a step live");
  }
  // A search descends over steps, so `--at` here is a step and never an effect
  // key: the fork points between two steps are not a sequence to walk down.
  const from = readCount(bounds.atRaw, "--at (search starts at a step)");
  const until = bounds.until === undefined ? undefined : new RegExp(bounds.until);

  const parent = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  const agent = { ...parent.agent, ...mod.agent };
  const top = Math.min(from ?? parent.steps - 1, parent.steps - 1);

  const repeat = bounds.repeat ?? 1;
  io.out(`${bold(runId)}  ${statusLabel(parent.status)}  ${dim(`· ${plural(parent.steps, "step")}`)}\n`);
  io.out(
    dim(
      `${agent.name} · ${agent.model} · forking from step ${top} down, until the answer ` +
        `${until === undefined ? "is not the recorded one" : `matches /${until.source}/`}` +
        `${repeat > 1 ? `, ${repeat} times over at each` : ""}\n\n`,
    ),
  );

  const report = await searchForkPoints(runId, {
    provider: mod.provider ?? (await anthropic()),
    tools: mod.tools ?? [],
    agent: mod.agent,
    input: mod.input,
    budget: mod.budget,
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    ...(from === undefined ? {} : { from }),
    ...(bounds.downTo === undefined ? {} : { downTo: bounds.downTo }),
    ...(bounds.maxForks === undefined ? {} : { maxForks: bounds.maxForks }),
    ...(bounds.repeat === undefined ? {} : { repeat: bounds.repeat }),
    ...(until === undefined ? {} : { until: (result) => until.test(result.output) }),
    onTrial: (trial) => {
      const verdict = trial.unstable
        ? yellow("unstable")
        : trial.matched
          ? green(until === undefined ? "differs" : "matches")
          : trial.status === "completed"
            ? dim(until === undefined ? "same" : "no match")
            : statusLabel(trial.status);
      // A word is enough for a fork point cut once. Cut several times, the count
      // is the thing worth reading — most of all on the ones that did not settle.
      const tally = repeat > 1 ? dim(` ${trial.matches} of ${trial.runs.length}`) : "";
      io.out(
        `  ${`step ${trial.atStep}`.padEnd(8)} ${padLabel(verdict, 8)}${tally} ` +
          dim(`${formatUsd(trial.billedUsd)} billed · ${formatUsd(trial.savedUsd)} free\n`),
      );
      io.out(`  ${" ".repeat(8)} ${dim(truncate(trial.error ?? trial.output, 62))}\n`);
    },
  });

  if (report.tried.length === 0) {
    io.out(
      `${dim("nothing to try")}: step ${top} is not a fork point of a run with ` +
        `${plural(parent.steps, "step")}\n`,
    );
    return 1;
  }

  io.out("\n");
  if (report.found === undefined) {
    const wanted =
      until === undefined ? "moved off the recorded one" : `matched /${until.source}/`;
    io.out(
      `${yellow("not found")}: ${plural(report.tried.length, "fork point")} down to step ` +
        `${report.downTo}, and ` +
        (report.repeat > 1
          ? `at none of them had the answer ${wanted} every one of the ${report.repeat} times it was cut`
          : `the answer never ${wanted}`) +
        `\n`,
    );
    if (report.stopped !== undefined) io.out(`${dim(report.stopped)}\n`);
  } else {
    io.out(
      `${green(`found at step ${report.found.atStep}`)} ${report.found.runId}\n` +
        dim(
          report.found.atStep === report.from
            ? `  the first fork point tried, so nothing below it had to be\n`
            : `  the highest fork point this change takes at — above it the run answered the same\n`,
        ),
    );
  }

  // The fork point that took some of the time is the finding `--repeat` exists
  // to produce, and it is worth saying whether or not one below it settled: a
  // change that takes two forks in three is not a change that takes at step N.
  if (report.unstable !== undefined) {
    const t = report.unstable;
    io.out(
      `${yellow(`unstable at step ${t.atStep}`)}\n` +
        dim(
          `  ${t.matches} of ${plural(t.runs.length, "fork")} made there answered what this ` +
            `search is looking for, and the rest did not —\n  the answer at that fork point is ` +
            `not the same twice, so it is not somewhere a change can be located\n`,
        ),
    );
  }

  const controlled = report.tried.map((t) => t.controlled).filter((c) => c !== undefined);
  const contradiction = controlled.find((c) => !c.ok)?.contradiction;
  if (contradiction !== undefined) {
    io.out(`${red("not controlled")}: ${contradiction}\n`);
  } else if (controlled.length > 0) {
    // Summed over the fork points rather than reduced to their smallest: a fork
    // at step 0 replays nothing and holds nobody to anything, and averaging that
    // in with the fork points that did would understate what was checked.
    const held = controlled.reduce((sum, c) => sum + c.claimed, 0);
    const substituted = controlled.reduce((sum, c) => sum + c.excused, 0);
    io.out(
      dim(
        `controlled: ${plural(held, "effect")} replayed identically by the ` +
          `${report.repeat} forks of each fork point` +
          `${substituted === 0 ? "" : `, ${substituted} of them a value they were told to substitute`}\n`,
      ),
    );
  }
  const forks = report.tried.reduce((sum, t) => sum + t.runs.length, 0);
  io.out(
    dim(
      `  ${plural(forks, "fork")} · ${formatUsd(report.billedUsd)} billed · ` +
        `${formatUsd(report.savedUsd)} not spent again out of ${formatUsd(report.costUsd)}\n`,
    ),
  );
  return report.found === undefined || contradiction !== undefined ? 1 : 0;
}

/**
 * Several changes at one fork point, off one replayed prefix.
 *
 * `search` fixes the change and varies the fork point; this varies the change
 * and fixes the fork point, which is the shape the question usually has once
 * you know where to cut. The arms are the module's, because they are code —
 * prompts to try, values to substitute — and the run they re-enter supplies
 * everything else.
 */
async function cmdSweep(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  atRaw: string | undefined,
  modulePath: string | undefined,
  { overrides, onDivergence, allowIrreversible }: Reentry,
): Promise<number> {
  if (!runId) return fail(io, "sweep needs a run id");
  if (atRaw === undefined) {
    return fail(io, "sweep needs --at <step|effect-key>: where every arm starts running live");
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
    return fail(io, "sweep needs --module <path>: the arms and the tools their live steps run");
  }

  const parent = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  if (mod.arms === undefined || mod.arms.length === 0) {
    return fail(
      io,
      `module "${modulePath}" exports no arms — a sweep needs "arms", an array of ` +
        `{ name, agent, overrides } saying what to try at ${atRaw}`,
    );
  }
  const agent = { ...parent.agent, ...mod.agent };
  const where = at.atEffect ?? `step ${at.atStep}`;

  io.out(`${bold(runId)}  ${statusLabel(parent.status)}  ${dim(`· ${plural(parent.steps, "step")}`)}\n`);
  io.out(
    dim(
      `${agent.name} · ${agent.model} · ${plural(mod.arms.length, "arm")} at ${where}, ` +
        `off one replayed prefix\n\n`,
    ),
  );

  const width = Math.max(...mod.arms.map((arm, i) => (arm.name ?? `arm ${i + 1}`).length), 8);
  const report = await sweepForkPoint(runId, {
    provider: mod.provider ?? (await anthropic()),
    ...at,
    tools: mod.tools ?? [],
    agent: mod.agent,
    input: mod.input,
    budget: mod.budget,
    arms: mod.arms,
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    onTrial: (trial) => printArm(io, trial, width),
  });

  io.out(`\n${controlLine(report.control)}\n`);
  io.out(
    dim(
      `${plural(report.arms.length, "arm")} · ${formatUsd(report.billedUsd)} billed · ` +
        `${formatUsd(report.savedUsd)} not spent again out of ${formatUsd(report.costUsd)}\n`,
    ),
  );
  return report.control.ok && report.arms.every((a) => a.status === "completed") ? 0 : 1;
}

function printArm(io: Io, trial: SweepTrial, width: number): void {
  const moved = trial.staleFacets.length > 0 ? dim(`  ${trial.staleFacets.join(", ")}`) : "";
  const indent = `  ${" ".repeat(width)}  `;
  io.out(
    `  ${padLabel(trial.name, width)}  ${padLabel(statusLabel(trial.status), 10)} ` +
      dim(`${formatUsd(trial.billedUsd)} billed · ${formatUsd(trial.savedUsd)} free`) +
      `${moved}\n`,
  );
  // Each arm is a run of its own, and the name is only good inside this report
  // — show, diff and verify want the id.
  if (trial.runId !== undefined) io.out(`${indent}${dim(trial.runId)}\n`);
  io.out(`${indent}${dim(truncate(trial.error ?? trial.output, 68))}\n`);
}

/**
 * What the arms shared, which is the whole claim a sweep makes over running the
 * agent once per arm: they differ in what was varied and in nothing below it.
 */
function controlLine(control: {
  arms: number;
  claimed: number;
  excused: number;
  contradiction?: string;
  ok: boolean;
}): string {
  if (!control.ok) return `${red("not controlled")}: ${control.contradiction}`;
  if (control.arms < 2) {
    return dim(`one arm ran, so there was nothing to hold its prefix against`);
  }
  const substituted =
    control.excused === 0
      ? ""
      : `, ${control.excused} of them ${control.excused === 1 ? "a value" : "values"} ` +
        `an arm was told to substitute`;
  return (
    green("controlled") +
    `: ${plural(control.claimed, "effect")} replayed identically by all ` +
    `${plural(control.arms, "arm")}${substituted}`
  );
}

/**
 * Take each recorded answer away in turn and see whether the run still arrives
 * where it did. Every trial replays everything up to the call it drops, so the
 * whole question costs one live tail per call rather than one run per call.
 */
async function cmdAblate(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  { onDivergence, allowIrreversible }: Reentry,
  narrow: { only: readonly string[]; instead: string | undefined; maxForks: number | undefined },
): Promise<number> {
  if (!runId) return fail(io, "ablate needs a run id");
  if (modulePath === undefined) {
    return fail(io, "ablate needs --module <path>: the tools and provider its live tails run");
  }

  const parent = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  const calls = recordedToolCalls(store.read(runId));

  io.out(`${bold(runId)}  ${statusLabel(parent.status)}  ${dim(`· ${plural(parent.steps, "step")}`)}\n`);
  io.out(
    dim(
      `${parent.agent.name} · ${parent.agent.model} · ` +
        `${plural(calls.length, "recorded tool call")}, each dropped from the step after it\n\n`,
    ),
  );
  if (calls.length === 0) {
    io.out(dim("this run records no tool calls, so its answer rests on nothing to take away\n"));
    return 0;
  }

  const width = Math.max(...calls.map((c) => c.key.length));
  const report = await ablateRun(runId, {
    provider: mod.provider ?? (await anthropic()),
    tools: mod.tools ?? [],
    budget: mod.budget,
    store,
    ...(narrow.only.length > 0 ? { only: narrow.only } : {}),
    ...(narrow.instead === undefined ? {} : { instead: narrow.instead }),
    ...(narrow.maxForks === undefined ? {} : { maxForks: narrow.maxForks }),
    onDivergence: onDivergence ?? "strict",
    allowIrreversible,
    onTrial: (trial) => printAblation(io, trial, width),
  });

  const tried = report.trials.length;
  io.out(
    `\n${report.needed} of ${plural(tried, "recorded answer")} this run's conclusion depends on\n`,
  );
  if (report.stopped !== undefined) io.out(dim(`${report.stopped}\n`));
  io.out(`${ablationControlLine(report.control, runId)}\n`);
  io.out(
    dim(
      `${plural(report.control.forks, "fork")} · ${formatUsd(report.billedUsd)} billed · ` +
        `${formatUsd(report.savedUsd)} not spent again out of ${formatUsd(report.costUsd)}\n`,
    ),
  );
  return report.control.ok && report.trials.every((t) => t.verdict !== "inconclusive") ? 0 : 1;
}

function printAblation(io: Io, trial: AblationTrial, width: number): void {
  const paint =
    trial.verdict === "needed" ? cyan : trial.verdict === "spare" ? dim : (s: string) => yellow(s);
  const label = trial.verdict === "inconclusive" ? statusLabel(trial.status) : paint(trial.verdict);
  const stale = trial.staleFacets.length > 0 ? dim(`  ${trial.staleFacets.join(", ")}`) : "";
  const indent = `  ${" ".repeat(width)}  `;

  io.out(
    `  ${trial.key.padEnd(width)}  ${padLabel(label, 8)} ` +
      dim(`${formatUsd(trial.billedUsd)} billed · ${formatUsd(trial.savedUsd)} free`) +
      `${stale}\n`,
  );
  // The answer that was taken away, then the answer the run gave without it —
  // the two lines the verdict is a comparison of. Each trial is a run of its
  // own, so its id goes between them: show, diff and verify all want it.
  io.out(
    `${indent}${dim(`dropped ${truncate(JSON.stringify(trial.input), 30)} → `)}` +
      `${dim(truncate(trial.recorded.content, 40))}\n`,
  );
  io.out(`${indent}${dim(trial.runId)}\n`);
  io.out(`${indent}${truncate(trial.error ?? trial.output, 68)}\n`);
}

/**
 * What each trial owed the run it came from: the prefix below its drop, held
 * unchanged. It is the claim that makes an ablation a counterfactual rather
 * than a second run — the substituted value is the whole of the difference.
 */
function ablationControlLine(control: AblationControl, runId: string): string {
  if (!control.ok) return `${red("not controlled")}: ${control.contradiction}`;
  if (control.forks === 0) return dim("no fork ran, so there was nothing to hold to a prefix");
  return (
    green("controlled") +
    `: each of ${plural(control.forks, "fork")} replayed ${runId}'s prefix unchanged ` +
    `except the one value it dropped — ${plural(control.claimed, "effect")} in all`
  );
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
  printAmbient(io, result.events);
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

/** A bound on a search: a step index or a number of forks, never negative. */
function readCount(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${name} takes a whole number of zero or more, got "${value}"`);
  }
  return count;
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
