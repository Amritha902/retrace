#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadRunModule, type RunModule } from "./module.ts";
import { formatUsd } from "./pricing.ts";
import { effectsOf, fork, inspect, replay } from "./replay.ts";
import { DEFAULT_STORE_DIR, RunStore } from "./store.ts";
import type { ContentBlock, Provider, RetraceEvent } from "./types.ts";

const USAGE = `retrace — inspect and re-run recorded agent runs

  retrace ls                    list runs, newest last
  retrace show <run-id>         print the run's timeline
  retrace cost <run-id>         per-step spend, and what replay saved
  retrace diff <run-a> <run-b>  compare two runs step by step
  retrace replay <run-id>       re-run it from the log, and check it reproduces
  retrace fork <run-id> --at N  replay the steps below N, then run live

Options
  --dir <path>              store directory (default: ${DEFAULT_STORE_DIR})
  --at <n>                  first step a fork executes for real
  --module <path>           module exporting the live half of the run — tools,
                            a provider, and agent fields to override. Required
                            by fork; replay only needs it to go past the log.
  --on-divergence <policy>  strict (default) stops when the log disagrees with
                            the loop; live executes from that point instead
`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

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
      return cmdReplay(io, store, rest[0], modulePath, onDivergence);
    case "fork":
      return cmdFork(io, store, rest[0], atRaw, modulePath, onDivergence);
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
        ? dim(`  ← ${s.forkedFrom.runId} @ ${s.forkedFrom.atStep}`)
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
    io.out(dim(`forked from ${summary.forkedFrom.runId} at step ${summary.forkedFrom.atStep}\n`));
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
      io.out(`  ${tag} ${event.kind.padEnd(5)} ${dim(event.key)}${timing}\n`);
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
    onDivergence: onDivergence ?? "strict",
    onEvent: (event) => printEvent(io, event),
  });

  const again = effectsOf(result.events);
  const divergedAt = firstDivergence(recorded, again);
  io.out(`\n${dim("new run")} ${result.runId}\n`);

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
  return 0;
}

async function cmdFork(
  io: Io,
  store: RunStore,
  runId: string | undefined,
  atRaw: string | undefined,
  modulePath: string | undefined,
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
    onDivergence: onDivergence ?? "strict",
    onEvent: (event) => printEvent(io, event),
  });

  io.out(`\n${dim("new run")} ${result.runId}\n`);
  if (result.totals.savedUsd > 0) {
    io.out(green(`the replayed prefix saved ${formatUsd(result.totals.savedUsd)}\n`));
  }
  return result.status === "failed" ? 1 : 0;
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
