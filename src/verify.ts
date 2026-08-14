import {
  orderFacets,
  requestFacets,
  requestFingerprint,
  toolFacets,
  toolFingerprint,
} from "./agent.ts";
import { formatUsd } from "./pricing.ts";
import { rebuildRequests, recordedMessages, type RebuiltCall } from "./rebuild.ts";
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
 *
 * `requests` asks the one neither of them can, because both compare a log with
 * another log: whether a log's answers are answers to its own questions. That is
 * what makes the run at the top of a lineage checkable at all.
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
    checkRequests(events),
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

  // A throw ends the run, so a log that carries on past one is describing
  // something the loop cannot do: a spliced log, or a failure edited in.
  const all = events.filter((e): e is Effect => e.type === "effect");
  const threw = all.findIndex((e) => e.failed !== undefined);
  if (threw !== -1 && threw !== all.length - 1) {
    const event = all[threw]!;
    return failed(
      name,
      `${event.kind}:${event.key} is recorded as having thrown, but the log records ` +
        `${plural(all.length - 1 - threw, "more effect")} after it`,
    );
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
 * Whether the log's answers are answers to the log's own questions.
 *
 * Everything else here checks a log against something outside it — the parent it
 * forked from, the ancestor that paid, the totals it reported. Run those against
 * an original run and there is nothing to compare it with, so a value edited in
 * the log that started a lineage passes every one of them, and so does every
 * fork that faithfully replays the edit.
 *
 * A log does hold enough to check itself, though, because it holds both halves.
 * Beside each recorded answer is a digest of what was asked, and what was asked
 * is the conversation the earlier answers build — so rebuilding the run's
 * requests from its own effects and comparing digests says whether the two agree.
 * Edit a tool result and the next model call is recorded against a conversation
 * the log no longer produces; reorder two steps, splice in an effect, change the
 * agent's prompt after the fact, and the same thing happens.
 *
 * This is the check the rest of them bottom out in. It needs no store, no parent
 * and no network, which is what makes it the one that still works on the run at
 * the top of a lineage.
 */
function checkRequests(events: readonly RetraceEvent[]): Check {
  const name = "requests";
  const rebuilt = rebuildRequests(events);
  if (rebuilt.blocked !== undefined) return skipped(name, rebuilt.blocked);

  if (rebuilt.outcomeless !== undefined) {
    return failed(
      name,
      `${rebuilt.outcomeless.kind}:${rebuilt.outcomeless.key} records neither a value nor a ` +
        `failure, so nothing in this log says how the run got past it`,
    );
  }

  const [orphan] = rebuilt.unreached;
  if (orphan !== undefined) {
    return failed(name, `${orphan.kind}:${orphan.key} is in the log, and nothing in it asks for that call`);
  }

  let checked = 0;
  let undigested = 0;
  for (const call of rebuilt.calls) {
    const { effect } = call;
    // Tool calls only started carrying a digest after model calls did, and a log
    // written before either is reported unchecked rather than guessed at.
    if (effect.requestHash === undefined) {
      undigested++;
      continue;
    }
    const stamp = stampOf(call);
    if (stamp.hash === effect.requestHash) {
      checked++;
      continue;
    }
    const moved = movedFacets(effect.requestFacets, stamp.facets);
    return failed(
      name,
      call.kind === "model"
        ? `model:${effect.key} was recorded against a request this log does not build` +
          (moved.length > 0 ? ` — ${moved.join(", ")} moved` : "")
        : `tool:${effect.key} holds the answer to a different input than the response above it asks for`,
    );
  }

  // After the digests, because they name the call and the component that moved
  // where these can only name a message. What they add is the last turn of a
  // run, whose own digest was taken before it answered and so survives an edit
  // to what it said — and any edit to the record a reader is shown rather than
  // to the record the digests cover. `explainStale` reads these.
  const recorded = recordedMessages(events);
  if (recorded.length !== rebuilt.messages.length) {
    return failed(
      name,
      `the log records ${plural(recorded.length, "message")} and its effects build ${rebuilt.messages.length}`,
    );
  }
  for (const [i, was] of recorded.entries()) {
    const now = rebuilt.messages[i]!;
    if (was.step === now.step && fingerprint(was.message) === fingerprint(now.message)) continue;
    return failed(
      name,
      `the ${was.message.role} message recorded at step ${was.step} is not the one this log's effects build`,
    );
  }

  if (checked === 0) {
    return skipped(
      name,
      undigested === 0
        ? "the log records no model or tool call, so there is no request in it to rebuild"
        : `none of its ${plural(undigested, "call")} carries a request digest: this log predates them`,
    );
  }
  return ok(
    name,
    `${checked} calls answer the request this log rebuilds, digest for digest` +
      (undigested > 0 ? `; ${plural(undigested, "call")} predates the digests` : ""),
  );
}

/** What the loop would have stamped this call with, had it made it just now. */
function stampOf(call: RebuiltCall): { hash: string; facets: Record<string, string> } {
  return call.kind === "model"
    ? { hash: requestFingerprint(call.request), facets: requestFacets(call.request) }
    : { hash: toolFingerprint(call.call), facets: toolFacets(call.call) };
}

/**
 * The components two stamps disagree on. A facet on one side and not the other
 * counts as moved — the component is there in one request and absent from the
 * other — and a recorded stamp with no facets at all names nothing rather than
 * naming everything.
 */
function movedFacets(
  was: Record<string, string> | undefined,
  now: Record<string, string>,
): string[] {
  if (was === undefined) return [];
  return orderFacets(
    [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((f) => was[f] !== now[f]),
  );
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
  if (origin.atEffect !== undefined && !recorded.some((e) => e.key === origin.atEffect)) {
    return failed(
      name,
      `this run says it went live at ${origin.atEffect}, and ${origin.runId} records no such ` +
        `effect for it to have gone live at`,
    );
  }
  const liveFrom = liveFromIndex(recorded, origin);

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
      liveFrom !== undefined &&
      (effect.kind === "model" || effect.kind === "tool") &&
      parent.index >= liveFrom
    ) {
      return failed(
        name,
        `${effect.kind}:${effect.key} was replayed, and this fork was meant to run live from ${describeForkPoint(origin)}`,
      );
    }
    if (effect.overridden) {
      substituted++;
      continue;
    }
    if (outcomeOf(effect) !== outcomeOf(parent)) {
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
 * Where in the parent's effect sequence this fork was meant to stop replaying —
 * the boundary its free prefix has to sit below.
 *
 * A step fork point and an effect fork point are the same boundary named two
 * ways, so both resolve to an index in the parent's log and the check is one
 * comparison rather than two. Undefined for a full replay or a resume, which
 * are entitled to the whole log. Callers have already established that a named
 * fork point is one of the parent's effects.
 */
function liveFromIndex(recorded: readonly Effect[], origin: ForkOrigin): number | undefined {
  if (origin.atEffect !== undefined) {
    return recorded.find((e) => e.key === origin.atEffect)!.index;
  }
  const atStep = origin.atStep;
  if (typeof atStep !== "number") return undefined;
  return recorded.find((e) => e.step >= atStep)?.index ?? recorded.length;
}

/** The fork point as the command that made it named it. */
function describeForkPoint(origin: ForkOrigin): string {
  return origin.atEffect ?? `step ${origin.atStep}`;
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
  let below = { runId, outcome: outcomeOf(effect) };

  for (const ancestor of ancestry.chain) {
    const recorded = ancestor.effects.get(lookup);
    if (recorded === undefined) {
      return {
        kind: "failed",
        detail: `${lookup} was served from the log, but ${ancestor.runId} in this run's lineage records no such effect`,
      };
    }
    if (outcomeOf(recorded) !== below.outcome) {
      return {
        kind: "failed",
        detail: `${ancestor.runId} records a different value for ${lookup} than ${below.runId}, which took it from there`,
      };
    }
    if (recorded.overridden) return { kind: "substituted" };
    if (!recorded.replayed) return { kind: "executed", runId: ancestor.runId };
    below = { runId: ancestor.runId, outcome: outcomeOf(recorded) };
  }

  if (ancestry.incomplete !== undefined) return { kind: "untraced" };
  return {
    kind: "failed",
    detail:
      `${lookup} is free in every run back to ${below.runId}, which records no run to have come ` +
      `from — nothing in this lineage ever executed it`,
  };
}

/**
 * What an effect came back with, as one comparable string.
 *
 * A throw is an outcome as much as a value is, and comparing only `value` would
 * let a log that turned a recorded failure into a success — or a success into a
 * failure — pass as the prefix its parent recorded. That is exactly the
 * doctoring these two checks exist to catch.
 */
function outcomeOf(effect: Pick<Effect, "value" | "failed">): string {
  return fingerprint({ value: effect.value, failed: effect.failed ?? null });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
