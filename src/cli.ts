#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
} from "./replay.ts";
import { renderReport } from "./report.ts";
import { DEFAULT_STORE_DIR, RunStore } from "./store.ts";
import { verifyRun } from "./verify.ts";
import type { ContentBlock, ForkOrigin, Provider, RetraceEvent } from "./types.ts";

const USAGE = `retrace — inspect and re-run recorded agent runs

  retrace ls                    list runs, newest last
  retrace show <run-id>         print the run's timeline
  retrace cost <run-id>         per-step spend, and what replay saved
  retrace diff <run-a> <run-b>  compare two runs step by step
  retrace replay <run-id>       re-run it from the log, and check it reproduces
  retrace fork <run-id> --at N  replay the steps below N, then run live
  retrace resume <run-id>       carry on a run that stopped early, from its log
  retrace report <run-id>       write the run as one self-contained HTML page
  retrace verify <run-id>       check the log against its own claims, and a
                                fork's free prefix against the run it came from

Options
  --dir <path>              store directory (default: ${DEFAULT_STORE_DIR})
  --at <n>                  first step a fork executes for real
  -o, --out <path>          where report writes its HTML; "-" for stdout
                            (default: <run-id>.html)
  --module <path>           module exporting the live half of the run — tools,
                            a provider, and agent fields to override. Required
                            by fork and resume; replay only needs it to go past
                            the log.
  --set <key>=<value>       serve <value> in place of the effect recorded under
                            <key>, as show prints it — "step:2#0:search=nothing
                            found". Repeatable; the key must be below --at.
  --on-divergence <policy>  strict (default) stops when the log disagrees with
                            the loop; live executes from that point instead
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
      return cmdReplay(io, store, rest[0], modulePath, overrides, onDivergence);
    case "fork":
      return cmdFork(io, store, rest[0], atRaw, modulePath, overrides, onDivergence);
    case "resume":
      return cmdResume(io, store, rest[0], modulePath, overrides, onDivergence);
    case "report":
      return cmdReport(io, store, rest[0], out);
    case "verify":
      return cmdVerify(io, store, rest[0]);
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
        ? dim(`  ← ${s.forkedFrom.runId} @ ${s.forkedFrom.resumed ? "resumed" : s.forkedFrom.atStep}`)
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
      : `forked from ${from.runId} at step ${from.atStep}`;
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
      const stale = event.stale ? yellow("  stale") : "";
      const set = event.overridden ? cyan("  set") : "";
      io.out(`  ${tag} ${event.kind.padEnd(6)} ${dim(event.key)}${timing}${set}${stale}\n`);
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
  const left = effectsOf(store.read(a));
  const right = effectsOf(store.read(b));

  io.out(`${bold(a)} ${dim("vs")} ${bold(b)}\n\n`);
  const n = Math.max(left.length, right.length);

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const lk = l ? `${l.kind}:${l.key}` : dim("(none)");
    const rk = r ? `${r.kind}:${r.key}` : dim("(none)");
    const sameKey = l && r && l.kind === r.kind && l.key === r.key;

    if (sameEffect(l, r)) {
      io.out(`${String(i).padStart(3)} ${green("=")} ${lk}\n`);
      continue;
    }
    io.out(
      sameKey
        ? `${String(i).padStart(3)} ${red("≠")} ${lk} ${dim("— same call, different result")}\n`
        : `${String(i).padStart(3)} ${red("≠")} ${lk} ${dim("|")} ${rk}\n`,
    );
  }

  const divergedAt = firstDivergence(left, right);
  io.out(
    divergedAt === -1
      ? `\n${green("identical")}: both runs produced the same ${n} effects\n`
      : `\n${yellow(`diverges at effect ${divergedAt}`)}; ${divergedAt} effects shared\n`,
  );
  return 0;
}

async function cmdReplay(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  modulePath: string | undefined,
  overrides: Overrides,
  onDivergence: "strict" | "live" | undefined,
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
  const stale = staleEffects(events).length;
  if (stale === 0) return;
  io.out(
    yellow(`${stale} replayed model call${stale === 1 ? "" : "s"}`) +
      dim(" answer a request this run no longer builds\n"),
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
  overrides: Overrides,
  onDivergence: "strict" | "live" | undefined,
): Promise<number> {
  if (!runId) return fail(io, "fork needs a run id");
  if (atRaw === undefined) {
    return fail(io, "fork needs --at <step>: the first step to run live");
  }
  const atStep = Number(atRaw);
  if (!Number.isInteger(atStep) || atStep < 0) {
    return fail(io, `--at takes a step number, got "${atRaw}"`);
  }
  if (modulePath === undefined) {
    return fail(io, "fork needs --module <path>: the live steps need tools and a provider");
  }

  const parent = inspect(runId, store);
  const mod = await loadRunModule(modulePath);
  const agent = { ...parent.agent, ...mod.agent };

  io.out(`${bold(runId)} ${dim(`→ fork at step ${atStep}`)}\n`);
  io.out(
    dim(
      `${agent.name} · ${agent.model} · steps below ${atStep} replay, ${atStep} onward runs live\n\n`,
    ),
  );

  const result = await fork(runId, {
    provider: mod.provider ?? (await anthropic()),
    atStep,
    tools: mod.tools ?? [],
    // Left undefined, each of these falls back to what the parent recorded.
    agent: mod.agent,
    input: mod.input,
    budget: mod.budget,
    store,
    overrides,
    onDivergence: onDivergence ?? "strict",
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
  overrides: Overrides,
  onDivergence: "strict" | "live" | undefined,
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
 * Reads two logs at most and executes nothing, so it says the same thing about
 * a run wherever that run is read — which is the only way the claim is worth
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

/** Where a re-entered run came from, in the words of the command that made it. */
function origin(from: ForkOrigin): string {
  if (from.resumed) {
    return `picked up from ${from.runId}, which stopped ${statusLabel(from.resumed.parentStatus)} after ${from.resumed.after} effects`;
  }
  return from.atStep === "all"
    ? `replayed from ${from.runId} in full`
    : `forked from ${from.runId} at step ${from.atStep}`;
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
    JSON.stringify(l.value) === JSON.stringify(r.value)
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
