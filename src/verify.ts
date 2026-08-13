import { orderFacets } from "./agent.ts";
import { formatUsd } from "./pricing.ts";
import { effectsOf } from "./replay.ts";
import { fingerprint, RunStore } from "./store.ts";
import { ZERO_USAGE, type ForkOrigin, type RetraceEvent, type Usage } from "./types.ts";

type Effect = Extract<RetraceEvent, { type: "effect" }>;

export type CheckStatus = "ok" | "failed" | "skipped";

export interface Check {
  /** Short label, as the CLI prints it. */
  name: string;
  status: CheckStatus;
  /** One line: what held, what didn't, or why it couldn't be checked at all. */
  detail: string;
}

export interface VerifyReport {
  runId: string;
  /** False only when a check failed. A skipped check leaves the report short, not wrong. */
  ok: boolean;
  /** True when every check actually ran. */
  complete: boolean;
  checks: Check[];
}

/**
 * Hold a run's log to the claims it makes about itself.
 *
 * The whole runtime asks you to trust a log instead of re-running the thing it
 * records: a fork bills nothing for its prefix because the prefix came out of
 * the parent, and the savings it reports are the difference. Nothing checked
 * either of those. This does, from the logs alone — no provider, no tools, no
 * network — so it holds for a run recorded on another machine a year ago.
 *
 * The interesting check is `parent`: every effect a fork served from the log is
 * looked up in the run it says it forked from and compared value for value. A
 * free prefix that is not the parent's prefix is the one failure that would
 * invalidate everything else, and it is invisible in the fork's own log.
 *
 * `lineage` asks the question one hop up cannot answer — who actually paid.
 */
export function verifyRun(runId: string, store: RunStore = new RunStore()): VerifyReport {
  return verifyEvents(runId, store.read(runId), store);
}

/**
 * The same, from events already in hand. `store` is only read to find the runs
 * this one inherited from.
 */
export function verifyEvents(
  runId: string,
  events: readonly RetraceEvent[],
  store?: RunStore,
): VerifyReport {
  const started = events.find((e) => e.type === "run.started");
  const origin = started?.type === "run.started" ? started.forkedFrom : undefined;

  const checks = [
    checkShape(events),
    checkAccounting(events),
    checkFreeReplay(events),
    checkMarkings(events, origin),
    checkParent(events, origin, store),
    checkLineage(runId, events, origin, store),
  ];

  return {
    runId,
    ok: checks.every((c) => c.status !== "failed"),
    complete: checks.every((c) => c.status === "ok"),
    checks,
  };
}

const ok = (name: string, detail: string): Check => ({ name, status: "ok", detail });
const failed = (name: string, detail: string): Check => ({ name, status: "failed", detail });
const skipped = (name: string, detail: string): Check => ({ name, status: "skipped", detail });

/**
 * The log is a sequence, and every consumer of it — replay, fork, resume, the
 * report — reads it as one. A gap in `seq` or a hole in the effect indices means
 * lines were reordered, dropped or spliced in, and everything downstream would
 * be quietly reading a run that never happened.
 */
function checkShape(events: readonly RetraceEvent[]): Check {
  const name = "shape";
  const first = events[0];
  if (first === undefined) return failed(name, "the log is empty");
  if (first.type !== "run.started") {
    return failed(name, `the log opens with a ${first.type} event instead of run.started`);
  }

  for (const [i, event] of events.entries()) {
    if (event.seq !== i) {
      return failed(name, `event ${i} carries seq ${event.seq}: a line is missing, or two logs are spliced together`);
    }
  }

  const startedSteps = new Set<number>();
  let expected = 0;
  let effects = 0;
  for (const event of events) {
    if (event.type === "step.started") startedSteps.add(event.step);
    if (event.type === "effect") {
      if (event.index !== expected) {
        return failed(
          name,
          `${event.kind}:${event.key} claims index ${event.index} where the effect sequence is at ${expected}`,
        );
      }
      expected++;
      effects++;
    }
    if (
      (event.type === "effect" || event.type === "charge" || event.type === "message") &&
      !startedSteps.has(event.step)
    ) {
      return failed(name, `a ${event.type} event belongs to step ${event.step}, which the log never starts`);
    }
  }

  const finishedAt = events.findIndex((e) => e.type === "run.finished");
  if (finishedAt !== -1 && finishedAt !== events.length - 1) {
    return failed(
      name,
      `run.finished is event ${finishedAt} of ${events.length}: something was appended after the run ended`,
    );
  }

  return ok(name, `${events.length} events, ${effects} effects, indices dense and in order`);
}

/**
 * `savedUsd` is the number the whole pitch rests on, and it is written into the
 * log by the same object that produced the charges — so it is a claim, not a
 * derivation, until something adds the charges up independently.
 */
function checkAccounting(events: readonly RetraceEvent[]): Check {
  const name = "accounting";
  const finished = events.find((e) => e.type === "run.finished");
  if (finished?.type !== "run.finished") {
    return skipped(name, "the log has no run.finished event, so there are no totals to hold it to");
  }
  const totals = finished.totals;

  // Summed in the order the run charged them, with the same operands, so this
  // is the same arithmetic rather than an approximation of it — which is why
  // the comparisons below can be exact.
  const usage: Usage = { ...ZERO_USAGE };
  let costUsd = 0;
  let billedUsd = 0;
  for (const event of events) {
    if (event.type !== "charge") continue;
    costUsd += event.costUsd;
    billedUsd += event.billedUsd;
    usage.inputTokens += event.usage.inputTokens;
    usage.outputTokens += event.usage.outputTokens;
    usage.cacheReadTokens += event.usage.cacheReadTokens;
    usage.cacheWriteTokens += event.usage.cacheWriteTokens;
  }

  if (costUsd !== totals.costUsd) {
    return failed(
      name,
      `the charges come to ${formatUsd(costUsd)} at list price, but the run reports ${formatUsd(totals.costUsd)}`,
    );
  }
  if (billedUsd !== totals.billedUsd) {
    return failed(
      name,
      `the charges come to ${formatUsd(billedUsd)} billed, but the run reports ${formatUsd(totals.billedUsd)}`,
    );
  }
  if (totals.savedUsd !== totals.costUsd - totals.billedUsd) {
    return failed(
      name,
      `the run claims to have saved ${formatUsd(totals.savedUsd)}, which is not ${formatUsd(totals.costUsd)} less ${formatUsd(totals.billedUsd)}`,
    );
  }
  for (const field of Object.keys(usage) as (keyof Usage)[]) {
    if (usage[field] !== totals.usage[field]) {
      return failed(
        name,
        `the charges account for ${usage[field]} ${field}, but the run reports ${totals.usage[field]}`,
      );
    }
  }

  const steps = events.filter((e) => e.type === "step.started").length;
  if (totals.steps !== steps) {
    return failed(name, `the run reports ${totals.steps} steps and the log starts ${steps}`);
  }

  // A step's tool calls are all charged against the budget before any of them
  // runs, so a run that ran out mid-batch counted calls the log never got to.
  const toolCalls = events.filter((e) => e.type === "effect" && e.kind === "tool").length;
  const short = finished.status === "budget_exceeded" ? totals.toolCalls < toolCalls : totals.toolCalls !== toolCalls;
  if (short) {
    return failed(name, `the run reports ${totals.toolCalls} tool calls and the log holds ${toolCalls}`);
  }

  return ok(
    name,
    `${formatUsd(totals.costUsd)} at list price, ${formatUsd(totals.billedUsd)} billed, ` +
      `${formatUsd(totals.savedUsd)} saved — the charges add up`,
  );
}

/**
 * What a replayed effect costs is the point of the runtime, so it is worth
 * checking rather than assuming: nothing served from the log took time, and
 * nothing served from the log was billed.
 */
function checkFreeReplay(events: readonly RetraceEvent[]): Check {
  const name = "free replay";
  let pending: Effect | undefined;
  let replayed = 0;
  let total = 0;

  for (const event of events) {
    if (event.type === "effect") {
      total++;
      if (event.replayed) {
        replayed++;
        if (event.durationMs !== 0) {
          return failed(
            name,
            `${event.kind}:${event.key} came out of the log but claims to have taken ${event.durationMs}ms`,
          );
        }
      }
      if (event.kind === "model") pending = event;
      continue;
    }
    if (event.type !== "charge") continue;
    if (pending === undefined) {
      return failed(name, `a charge at step ${event.step} follows no model call`);
    }
    if (pending.replayed && event.billedUsd !== 0) {
      return failed(
        name,
        `${pending.key} came out of the log but was billed ${formatUsd(event.billedUsd)}`,
      );
    }
    if (!pending.replayed && event.billedUsd !== event.costUsd) {
      return failed(
        name,
        `${pending.key} executed but was billed ${formatUsd(event.billedUsd)} against a list price of ${formatUsd(event.costUsd)}`,
      );
    }
    pending = undefined;
  }

  return ok(
    name,
    replayed === 0
      ? `nothing was replayed: all ${total} effects executed and were billed at list price`
      : `${replayed} of ${total} effects came out of the log, and none of them was billed`,
  );
}

/**
 * `stale` and `overridden` are the two things a log says about itself that a
 * reader cannot otherwise see, which makes them the two worth checking. Both
 * describe a value that came out of the log; on an effect that executed, either
 * one would be describing something that never happened.
 */
function checkMarkings(events: readonly RetraceEvent[], origin: ForkOrigin | undefined): Check {
  const name = "markings";
  const asked = new Set(origin?.overrides ?? []);
  let stale = 0;
  let overridden = 0;

  for (const effect of effectsOf(events)) {
    if (effect.stale) {
      if (!effect.replayed) {
        return failed(
          name,
          `${effect.kind}:${effect.key} executed, so it cannot be stale — only a recorded value can be answering an older question`,
        );
      }
      if (effect.requestHash === undefined) {
        return failed(name, `${effect.key} is marked stale but carries no request digest, so nothing could have compared`);
      }
      stale++;
    } else if (effect.staleFacets !== undefined) {
      return failed(
        name,
        `${effect.key} names ${effect.staleFacets.join(", ")} as having changed but is not marked stale — ` +
          `a request cannot have moved and matched`,
      );
    }
    if (effect.overridden) {
      if (!effect.replayed) {
        return failed(
          name,
          `${effect.kind}:${effect.key} executed, so nothing was substituted for it — a value is only served in place of a log read`,
        );
      }
      if (!asked.has(effect.key)) {
        return failed(name, `${effect.key} was substituted, but the run does not record having been asked to substitute it`);
      }
      overridden++;
    }
  }

  const moved = orderFacets(effectsOf(events).flatMap((e) => e.staleFacets ?? []));
  return ok(
    name,
    stale === 0 && overridden === 0
      ? "nothing in this log is marked stale or substituted"
      : `${stale} stale${moved.length > 0 ? ` (${moved.join(", ")})` : ""}, ` +
        `${overridden} substituted, all of them served from the log`,
  );
}

/**
 * The claim a fork's log cannot make on its own.
 *
 * A fork bills nothing for its prefix because the prefix came out of the
 * parent. Read on its own the fork's log shows a run that did a great deal of
 * work for free, and nothing in it says the work is the same work. So look the
 * parent up and compare, effect for effect, value for value.
 */
function checkParent(
  events: readonly RetraceEvent[],
  origin: ForkOrigin | undefined,
  store: RunStore | undefined,
): Check {
  const name = "parent";
  if (origin === undefined) {
    return skipped(name, "this run is not a fork, so there is no recorded prefix to hold it to");
  }
  if (store === undefined) {
    return skipped(name, `no store to read ${origin.runId} from`);
  }
  if (!store.exists(origin.runId)) {
    return skipped(name, `the run it came from ("${origin.runId}") is not in this store, so its prefix is unchecked`);
  }

  let recorded;
  try {
    recorded = effectsOf(store.read(origin.runId));
  } catch (cause) {
    return skipped(name, `the run it came from ("${origin.runId}") could not be read: ${describe(cause)}`);
  }
  const byKey = new Map(recorded.map((e) => [`${e.kind}:${e.key}`, e]));

  let matched = 0;
  let substituted = 0;
  for (const effect of effectsOf(events)) {
    if (!effect.replayed) continue;
    const parent = byKey.get(`${effect.kind}:${effect.key}`);
    if (parent === undefined) {
      return failed(
        name,
        `${effect.kind}:${effect.key} was served from the log, but ${origin.runId} records no such effect`,
      );
    }
    // Clock, id and random reads are keyed rather than positional and outlive
    // the fork point on purpose, so only the run's shape is held to it.
    if (
      typeof origin.atStep === "number" &&
      (effect.kind === "model" || effect.kind === "tool") &&
      effect.step >= origin.atStep
    ) {
      return failed(
        name,
        `${effect.kind}:${effect.key} was replayed at step ${effect.step}, which this fork was meant to run live from step ${origin.atStep}`,
      );
    }
    if (effect.overridden) {
      substituted++;
      continue;
    }
    if (fingerprint(effect.value) !== fingerprint(parent.value)) {
      return failed(
        name,
        `${effect.kind}:${effect.key} was served a different value than ${origin.runId} recorded for it`,
      );
    }
    matched++;
  }

  return ok(
    name,
    `${matched} replayed effect${matched === 1 ? " is" : "s are"} ${origin.runId}'s, value for value` +
      (substituted === 0 ? "" : `; ${substituted} substituted on purpose`),
  );
}

/**
 * Follow every free effect back to the run that ran it.
 *
 * `parent` proves a fork's prefix is its parent's. It says nothing about where
 * the *parent* got it, and a fork of a fork of a fork is the normal shape of
 * this thing: keep re-forking the same run and the money is claimed as saved
 * every time, on the strength of a log that only ever points one hop back. Read
 * the chain to its end and the claim becomes checkable — each free effect either
 * arrives at a run that executed and was billed for it, or it doesn't exist.
 *
 * Two failures live here and nowhere else. A log with a free prefix and no
 * parent to have taken it from is a saving nothing accounts for. And a value
 * altered in the middle of a lineage passes `parent` at both ends — the child
 * agrees with the doctored log it was forked from — while disagreeing with the
 * run that produced it. A third, a run that turns out to be its own ancestor,
 * is not something the runtime can produce at all, so finding one is enough.
 */
function checkLineage(
  runId: string,
  events: readonly RetraceEvent[],
  origin: ForkOrigin | undefined,
  store: RunStore | undefined,
): Check {
  const name = "lineage";
  const free = effectsOf(events).filter((e) => e.replayed);

  if (origin === undefined) {
    return free.length === 0
      ? ok(name, "every effect here executed here, so none of this run is owed to another")
      : failed(
          name,
          `${plural(free.length, "effect")} came out of a log, but this run records no run to have ` +
            `come from — nothing accounts for the work it did not pay for`,
        );
  }
  if (free.length === 0) {
    return ok(name, `nothing was served from ${origin.runId}'s log, so this run inherited nothing`);
  }
  if (store === undefined) return skipped(name, `no store to trace ${origin.runId} back through`);

  const ancestry = ancestryOf(origin.runId, store);
  if (ancestry.broken !== undefined) return failed(name, ancestry.broken);

  const executedBy = new Set<string>();
  let executed = 0;
  let substituted = 0;
  let untraced = 0;

  for (const effect of free) {
    // Substituted here on purpose: this run was asked for a value its lineage
    // never held, so there is nothing upstream for it to agree with.
    if (effect.overridden) {
      substituted++;
      continue;
    }
    const trail = trace(runId, effect, ancestry);
    if (trail.kind === "failed") return failed(name, trail.detail);
    if (trail.kind === "untraced") untraced++;
    else if (trail.kind === "substituted") substituted++;
    else {
      executed++;
      executedBy.add(trail.runId);
    }
  }

  if (untraced > 0) {
    const traced =
      executed === 0
        ? "nothing this run got free can be traced to the run that ran it"
        : `${executed} of ${free.length} free effects trace back to ${[...executedBy].sort().join(", ")}`;
    return skipped(name, `${traced}: the trail stops where ${ancestry.incomplete}`);
  }
  if (executed === 0) {
    return ok(
      name,
      "every free effect here inherits a substituted value, so nothing in this lineage ever ran one",
    );
  }

  const depth = ancestry.chain.length === 1 ? "" : ` ${plural(ancestry.chain.length, "run")}`;
  return ok(
    name,
    `${plural(executed, "free effect")} trace back${depth} to ${[...executedBy].sort().join(", ")}, ` +
      `which executed and paid for ${executed === 1 ? "it" : "them"}` +
      (substituted === 0
        ? ""
        : `; ${substituted} more ${substituted === 1 ? "carries a value" : "carry values"} substituted ` +
          `somewhere in this lineage rather than executed anywhere in it`),
  );
}

/** One run in a lineage, with its effects indexed the way a trace looks them up. */
interface Ancestor {
  runId: string;
  effects: ReadonlyMap<string, Effect>;
}

interface Ancestry {
  /** Nearest first: the parent, then its parent, up to a run that ran everything itself. */
  chain: Ancestor[];
  /** Why the walk stopped short of such a run — a log this store does not hold. */
  incomplete?: string;
  /** Something no sequence of forks could have produced. */
  broken?: string;
}

function ancestryOf(parentRunId: string, store: RunStore): Ancestry {
  const chain: Ancestor[] = [];
  const seen = new Set<string>();
  let next: string | undefined = parentRunId;

  while (next !== undefined) {
    if (seen.has(next)) {
      return {
        chain,
        broken: `"${next}" is its own ancestor, which no sequence of forks produces`,
      };
    }
    seen.add(next);
    if (!store.exists(next)) return { chain, incomplete: `"${next}" is not in this store` };

    let events: readonly RetraceEvent[];
    try {
      events = store.read(next);
    } catch (cause) {
      return { chain, incomplete: `"${next}" could not be read: ${describe(cause)}` };
    }

    const started = events.find((e) => e.type === "run.started");
    const origin = started?.type === "run.started" ? started.forkedFrom : undefined;
    chain.push({
      runId: next,
      effects: new Map(effectsOf(events).map((e) => [`${e.kind}:${e.key}`, e])),
    });
    next = origin?.runId;
  }

  return { chain };
}

type Trail =
  | { kind: "executed"; runId: string }
  | { kind: "substituted" }
  | { kind: "untraced" }
  | { kind: "failed"; detail: string };

/**
 * Walk one effect up the chain. Each run either ran it — in which case that is
 * where it came from — or was handed it by the run above, in which case the two
 * had better hold the same value.
 */
function trace(runId: string, effect: Effect, ancestry: Ancestry): Trail {
  const lookup = `${effect.kind}:${effect.key}`;
  let below = { runId, value: effect.value };

  for (const ancestor of ancestry.chain) {
    const recorded = ancestor.effects.get(lookup);
    if (recorded === undefined) {
      return {
        kind: "failed",
        detail: `${lookup} was served from the log, but ${ancestor.runId} in this run's lineage records no such effect`,
      };
    }
    if (fingerprint(recorded.value) !== fingerprint(below.value)) {
      return {
        kind: "failed",
        detail: `${ancestor.runId} records a different value for ${lookup} than ${below.runId}, which took it from there`,
      };
    }
    if (recorded.overridden) return { kind: "substituted" };
    if (!recorded.replayed) return { kind: "executed", runId: ancestor.runId };
    below = { runId: ancestor.runId, value: recorded.value };
  }

  if (ancestry.incomplete !== undefined) return { kind: "untraced" };
  return {
    kind: "failed",
    detail:
      `${lookup} is free in every run back to ${below.runId}, which records no run to have come ` +
      `from — nothing in this lineage ever executed it`,
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
