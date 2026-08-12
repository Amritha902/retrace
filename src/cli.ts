#!/usr/bin/env node
import { formatUsd } from "./pricing.ts";
import { effectsOf, inspect } from "./replay.ts";
import { RunStore } from "./store.ts";
import type { ContentBlock, RetraceEvent } from "./types.ts";

const USAGE = `retrace — inspect recorded agent runs

  retrace ls                    list runs, newest last
  retrace show <run-id>         print the run's timeline
  retrace cost <run-id>         per-step spend, and what replay saved
  retrace diff <run-a> <run-b>  compare two runs step by step

Options
  --dir <path>   store directory (default: .retrace)
`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function main(argv: string[]): number {
  const args = [...argv];
  let dir = ".retrace";
  const dirAt = args.indexOf("--dir");
  if (dirAt !== -1) {
    dir = args[dirAt + 1] ?? dir;
    args.splice(dirAt, 2);
  }

  const [command, ...rest] = args;
  const store = new RunStore(dir);

  switch (command) {
    case "ls":
      return cmdLs(store);
    case "show":
      return cmdShow(store, rest[0]);
    case "cost":
      return cmdCost(store, rest[0]);
    case "diff":
      return cmdDiff(store, rest[0], rest[1]);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

function cmdLs(store: RunStore): number {
  const ids = store.list();
  if (ids.length === 0) {
    process.stdout.write(dim(`no runs in ${store.dir}\n`));
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
      process.stdout.write(
        `${id.padEnd(width)}  ${padLabel(statusLabel(s.status), 16)}  ` +
          `${String(s.steps).padStart(2)} steps  ${cost.padStart(10)}${saved}${from}\n`,
      );
    } catch (cause) {
      process.stdout.write(`${id.padEnd(width)}  ${red("unreadable")}  ${describe(cause)}\n`);
    }
  }
  return 0;
}

function cmdShow(store: RunStore, runId: string | undefined): number {
  if (!runId) return fail("show needs a run id");
  const events = store.read(runId);
  const summary = inspect(runId, store);

  process.stdout.write(`${bold(runId)}  ${statusLabel(summary.status)}\n`);
  process.stdout.write(
    dim(`${summary.agent.name} · ${summary.agent.model} · via ${summary.provider}\n`),
  );
  if (summary.forkedFrom) {
    process.stdout.write(
      dim(`forked from ${summary.forkedFrom.runId} at step ${summary.forkedFrom.atStep}\n`),
    );
  }
  process.stdout.write(`\n${dim("input")}  ${truncate(summary.input, 200)}\n\n`);

  for (const event of events) {
    switch (event.type) {
      case "step.started":
        process.stdout.write(`${bold(`step ${event.step}`)}\n`);
        break;
      case "effect": {
        const tag = padLabel(event.replayed ? green("replayed") : yellow("live"), 9);
        const timing = event.replayed ? "" : dim(` ${event.durationMs}ms`);
        process.stdout.write(`  ${tag} ${event.kind.padEnd(5)} ${dim(event.key)}${timing}\n`);
        if (event.kind === "tool") {
          const v = event.value as { content?: string; isError?: boolean };
          process.stdout.write(
            `        ${v.isError ? red("error") : dim("→")} ${truncate(v.content ?? "", 120)}\n`,
          );
        }
        break;
      }
      case "message": {
        if (event.message.role !== "assistant") break;
        const said = textOf(event.message.content);
        if (said) process.stdout.write(`  ${dim("says")}  ${truncate(said, 200)}\n`);
        break;
      }
      case "run.finished":
        process.stdout.write(`\n${bold("finished")} ${statusLabel(event.status)}\n`);
        if (event.error) process.stdout.write(`  ${red(event.error)}\n`);
        process.stdout.write(`  ${totalsLine(event.totals)}\n`);
        break;
      default:
        break;
    }
  }
  return 0;
}

function cmdCost(store: RunStore, runId: string | undefined): number {
  if (!runId) return fail("cost needs a run id");
  const events = store.read(runId);
  const charges = events.filter((e): e is Extract<RetraceEvent, { type: "charge" }> => e.type === "charge");
  const replayedSteps = new Set(
    effectsOf(events).filter((e) => e.kind === "model" && e.replayed).map((e) => e.step),
  );

  process.stdout.write(`${bold(runId)}\n\n`);
  process.stdout.write(dim("step   in      out     list price   billed\n"));
  for (const c of charges) {
    const marker = replayedSteps.has(c.step) ? green(" replayed") : "";
    process.stdout.write(
      `${String(c.step).padStart(4)}  ${String(c.usage.inputTokens).padStart(6)}  ` +
        `${String(c.usage.outputTokens).padStart(6)}  ${formatUsd(c.costUsd).padStart(11)}  ` +
        `${formatUsd(c.billedUsd).padStart(9)}${marker}\n`,
    );
  }

  const finished = events.find((e) => e.type === "run.finished");
  if (finished?.type === "run.finished") {
    process.stdout.write(`\n${totalsLine(finished.totals)}\n`);
  }
  return 0;
}

function cmdDiff(store: RunStore, a: string | undefined, b: string | undefined): number {
  if (!a || !b) return fail("diff needs two run ids");
  const left = effectsOf(store.read(a));
  const right = effectsOf(store.read(b));

  process.stdout.write(`${bold(a)} ${dim("vs")} ${bold(b)}\n\n`);
  const n = Math.max(left.length, right.length);
  let firstDivergence = -1;

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const lk = l ? `${l.kind}:${l.key}` : dim("(none)");
    const rk = r ? `${r.kind}:${r.key}` : dim("(none)");
    const sameKey = l && r && l.kind === r.kind && l.key === r.key;
    const sameValue = sameKey && JSON.stringify(l.value) === JSON.stringify(r.value);

    if (sameValue) {
      process.stdout.write(`${String(i).padStart(3)} ${green("=")} ${lk}\n`);
      continue;
    }
    if (firstDivergence === -1) firstDivergence = i;
    process.stdout.write(
      sameKey
        ? `${String(i).padStart(3)} ${red("≠")} ${lk} ${dim("— same call, different result")}\n`
        : `${String(i).padStart(3)} ${red("≠")} ${lk} ${dim("|")} ${rk}\n`,
    );
  }

  process.stdout.write(
    firstDivergence === -1
      ? `\n${green("identical")}: both runs produced the same ${n} effects\n`
      : `\n${yellow(`diverges at effect ${firstDivergence}`)}; ${firstDivergence} effects shared\n`,
  );
  return 0;
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

function fail(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (cause) {
  // A missing or corrupt run is a user error, not a crash worth a stack trace.
  process.stderr.write(`${red("error")} ${describe(cause)}\n`);
  process.exitCode = 1;
}
