import { orderFacets } from "./agent.ts";
import { effectsOf, summarize, type RunSummary } from "./replay.ts";
import { fingerprint, RunStore } from "./store.ts";
import type { ForkOrigin, RetraceEvent } from "./types.ts";

type Effect = Extract<RetraceEvent, { type: "effect" }>;

/**
 * How two runs are related, as far as the two logs can say between themselves.
 *
 * Only the direct relations are named, because only they carry a claim two logs
 * can check on their own. A fork's log names the run it came from and nothing
 * further, so cousins — two runs whose common ancestor is several hops up — are
 * `unrelated` here even when a store holding the runs in between would show
 * otherwise. That is `verify`'s lineage walk, which needs those logs; this
 * needs the two in front of you.
 */
export type Kinship =
  | { kind: "same" }
  /** One forked, resumed or replayed directly from the other. */
  | { kind: "parent"; parent: "a" | "b"; origin: ForkOrigin }
  /** Both came directly from the same run. */
  | { kind: "siblings"; origin: string }
  | { kind: "unrelated" };

/**
 * Whether the two runs were asking the same thing at a position where they
 * answered differently.
 *
 * `diff` has always been able to say *where* two runs parted. This is the
 * question a reader asks next and no log could answer alone: were they even
 * asking the same thing there? Every model and tool call carries a digest of
 * what it was asked, and the two logs each carry their own — so putting them
 * side by side separates the two readings of one divergence.
 *
 * `moved` is the fork doing what you asked, and `facets` names which part of
 * the question moved — `system` on a rewritten prompt, `conversation` under an
 * override. An empty list is a question that moved with neither log saying
 * which part, exactly as an older log's `stale` marking names nothing.
 *
 * `same` is the reading that was invisible before and is usually the one worth
 * having: an identical question, answered two different ways. Nothing about
 * that is your change, and nothing in either log accounts for it — a model with
 * a temperature, a tool that reads something the journal does not cover, or a
 * corpus that moved between the two runs.
 */
export type Asked =
  | { kind: "moved"; facets: string[] }
  | { kind: "same" }
  /** The logs cannot say, and `why` is what stops them. */
  | { kind: "unknown"; why: string };

/** What the two logs hold at one position in their effect sequences. */
export interface EffectPair {
  index: number;
  a?: Effect;
  b?: Effect;
  /**
   * `same` is the same call with the same outcome. `value` is the same call
   * answered differently — the interesting one, since it is a run doing the
   * same thing and getting somewhere else. `call` is the two runs no longer
   * making the same calls at all, which is where a fork usually ends up.
   */
  verdict: "same" | "value" | "call";
  /**
   * Whether the two runs asked the same thing here. Present only on a `value`
   * verdict: a `call` verdict is two different calls, which is a divergence in
   * the shape of the run rather than in what one call was asked, and a `same`
   * one has nothing to explain.
   */
  asked?: Asked;
}

export interface RunComparison {
  a: RunSummary;
  b: RunSummary;
  kinship: Kinship;
  pairs: EffectPair[];
  /** Index of the first effect the two logs don't share, or -1 when they share all of them. */
  divergedAt: number;
  /**
   * How many leading effects the kinship obliges the two logs to hold
   * identically: the ones at least one of them took out of the other's log, or
   * out of the log they both came from, rather than executing. Zero for runs
   * with no relation to check.
   */
  claimed: number;
  /**
   * Positions inside `claimed` that are allowed to differ, because one of the
   * runs was told to serve something else there. Counted rather than listed:
   * the keys are in the fork's own `overrides`.
   */
  excused: number;
  /** Set when the two disagree inside `claimed`. */
  contradiction?: string;
  /** False only on a contradiction. Two runs that merely diverged are the point. */
  ok: boolean;
}

/**
 * Compare two recorded runs, and hold them to what their kinship claims.
 *
 * Diverging is what a fork is *for*, so the per-effect comparison is a
 * description and not a verdict. The verdict is about the other end of the run:
 * a fork bills nothing for its prefix because the prefix came out of the run it
 * forked from, and two runs that both replayed the same effect cannot hold
 * different values for it. One that does has a log that was edited, spliced, or
 * pointed at a parent it did not come from.
 *
 * `verify` makes that check against a parent. This one makes it *sideways*, and
 * that is the case it exists for: two forks off the same run must agree with
 * each other everywhere they both replayed, and checking it needs only the two
 * logs. The run they came from can be long gone — which is exactly when
 * `verify` gives up and reports its lineage check skipped.
 */
export function compareRuns(
  runA: string,
  runB: string,
  store: RunStore = new RunStore(),
): RunComparison {
  return compareEvents(runA, store.read(runA), runB, store.read(runB));
}

/** The same comparison, from events already in hand. */
export function compareEvents(
  runA: string,
  eventsA: readonly RetraceEvent[],
  runB: string,
  eventsB: readonly RetraceEvent[],
): RunComparison {
  const a = summarize(runA, eventsA);
  const b = summarize(runB, eventsB);
  const left = effectsOf(eventsA);
  const right = effectsOf(eventsB);

  const kinship = kinshipOf(a, b);
  const claimed = claimOf(kinship, left, right);

  const pairs: EffectPair[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    const seen = verdict(l, r);
    const asked = seen === "value" && l !== undefined && r !== undefined ? askedOf(l, r) : undefined;
    pairs.push({
      index: i,
      ...(l !== undefined ? { a: l } : {}),
      ...(r !== undefined ? { b: r } : {}),
      verdict: seen,
      ...(asked !== undefined ? { asked } : {}),
    });
  }

  const divergedAt = pairs.find((p) => p.verdict !== "same")?.index ?? -1;
  // An override serves a value the log never recorded, so the two runs are
  // meant to disagree at exactly those positions and nowhere else. The effects
  // between an override and the fork point still came out of the log unchanged,
  // which is why this excuses a position rather than ending the claim.
  const inside = pairs.slice(0, claimed);
  const substituted = (p: EffectPair) => p.a?.overridden === true || p.b?.overridden === true;
  const broken = inside.find((p) => p.verdict !== "same" && !substituted(p));

  const contradiction = broken === undefined ? undefined : explain(broken, kinship, a, b);

  return {
    a,
    b,
    kinship,
    pairs,
    divergedAt,
    claimed,
    excused: inside.filter(substituted).length,
    ...(contradiction !== undefined ? { contradiction } : {}),
    ok: contradiction === undefined,
  };
}

/**
 * Hold the two recorded questions against each other at one position the two
 * runs answered differently.
 *
 * The comparison is between the digests the two logs recorded at the time, not
 * between anything rebuilt now, so it says the same thing on a machine that has
 * neither run's tools and neither run's provider.
 */
function askedOf(l: Effect, r: Effect): Asked | undefined {
  // A value one of them was told to serve is not an answer to a question, so
  // there is no question to have moved. The fork's own `overrides` is where
  // that difference is on record.
  if (l.overridden === true || r.overridden === true) return undefined;

  // Clock, id and random reads are answers to no question — which is why they
  // carry no digest — so there is nothing here to compare.
  if (l.kind === "clock" || l.kind === "uuid" || l.kind === "random") return undefined;

  if (l.requestFacets !== undefined && r.requestFacets !== undefined) {
    const names = new Set([...Object.keys(l.requestFacets), ...Object.keys(r.requestFacets)]);
    const moved = [...names].filter((n) => l.requestFacets?.[n] !== r.requestFacets?.[n]);
    if (moved.length > 0) return { kind: "moved", facets: orderFacets(moved) };
    // Facets agreeing and the whole-request digest not is a component this
    // build hashes and does not attribute — the log says the question moved,
    // and nothing in it says which part.
    return l.requestHash === r.requestHash ? { kind: "same" } : { kind: "moved", facets: [] };
  }

  if (l.requestHash !== undefined && r.requestHash !== undefined) {
    return l.requestHash === r.requestHash ? { kind: "same" } : { kind: "moved", facets: [] };
  }

  // A fetch carries its digest in its key rather than beside it, so a shared
  // key already says the method, the URL and the body matched — except where
  // the body was one the journal could not read without taking it from the
  // fetch about to send it, and then the shared slot proves nothing.
  if (l.kind === "fetch") {
    return unreadBody(l) || unreadBody(r)
      ? {
          kind: "unknown",
          why: "the body of one of these requests was never read, so the slot they share does not say they asked the same thing",
        }
      : { kind: "same" };
  }

  return {
    kind: "unknown",
    why: "one of these calls was recorded before a call carried a digest of what it was asked",
  };
}

function unreadBody(effect: Effect): boolean {
  const value = effect.value as { request?: { unread?: true } } | null;
  return value?.request?.unread === true;
}

function verdict(l: Effect | undefined, r: Effect | undefined): EffectPair["verdict"] {
  if (l === undefined || r === undefined) return "call";
  if (l.kind !== r.kind || l.key !== r.key) return "call";
  return outcomeOf(l) === outcomeOf(r) ? "same" : "value";
}

function kinshipOf(a: RunSummary, b: RunSummary): Kinship {
  if (a.runId === b.runId) return { kind: "same" };
  if (b.forkedFrom?.runId === a.runId) return { kind: "parent", parent: "a", origin: b.forkedFrom };
  if (a.forkedFrom?.runId === b.runId) return { kind: "parent", parent: "b", origin: a.forkedFrom };
  if (a.forkedFrom !== undefined && a.forkedFrom.runId === b.forkedFrom?.runId) {
    return { kind: "siblings", origin: a.forkedFrom.runId };
  }
  return { kind: "unrelated" };
}

/**
 * How far into the two sequences the kinship reaches.
 *
 * A run's leading replayed effects are the ones it took from its parent's log
 * at the parent's own indices, so they are that log's values at those indices —
 * which is what makes a positional comparison meaningful at all. Past the first
 * effect a run executed, its log is its own and the two are free to differ.
 *
 * Only one hop is claimed. For a child that hop reaches its parent directly;
 * for two siblings it reaches the run they both came from, so they agree with
 * each other as far as the shorter of their two free prefixes.
 */
function claimOf(kinship: Kinship, left: readonly Effect[], right: readonly Effect[]): number {
  switch (kinship.kind) {
    case "same":
      return Math.max(left.length, right.length);
    case "parent": {
      const [child, parent] = kinship.parent === "a" ? [right, left] : [left, right];
      return Math.min(freeThrough(child), parent.length);
    }
    case "siblings":
      return Math.min(freeThrough(left), freeThrough(right));
    case "unrelated":
      return 0;
  }
}

/** How many effects a run served from a log before it executed anything of its own. */
function freeThrough(effects: readonly Effect[]): number {
  const ran = effects.findIndex((e) => !e.replayed);
  return ran === -1 ? effects.length : ran;
}

function explain(pair: EffectPair, kinship: Kinship, a: RunSummary, b: RunSummary): string {
  const call = describe(pair.a) === describe(pair.b) ? describe(pair.a) : `${describe(pair.a)} and ${describe(pair.b)}`;
  const where = `effect ${pair.index} (${call})`;

  if (kinship.kind === "siblings") {
    return (
      `${where} differs, and ${a.runId} and ${b.runId} both replayed it from ${kinship.origin} — ` +
      `two runs cannot have taken different values out of the same log`
    );
  }
  if (kinship.kind === "parent") {
    const [child, parent] = kinship.parent === "a" ? [b, a] : [a, b];
    return (
      `${where} differs, and ${child.runId} replayed it from ${parent.runId} rather than running it — ` +
      `a free prefix that is not the prefix it came from`
    );
  }
  // Two readings of the same log, so this is a comparison that cannot fail.
  return `${where} differs between two readings of ${a.runId}`;
}

function describe(effect: Effect | undefined): string {
  return effect ? `${effect.kind}:${effect.key}` : "nothing";
}

/**
 * What an effect came back with, as one comparable string. A throw is an
 * outcome as much as a value is — see `verify`, which compares the same way and
 * for the same reason.
 */
function outcomeOf(effect: Effect): string {
  return fingerprint({ value: effect.value, failed: effect.failed ?? null });
}
