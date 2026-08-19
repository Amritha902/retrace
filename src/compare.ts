import { orderFacets } from "./agent.ts";
import { DETERMINISTIC_KINDS } from "./journal.ts";
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

/**
 * What two logs took out of the same log *above* the prefix they replayed.
 *
 * The positional sequence is cut at the fork point, but the key table is not:
 * a live tail that reads the clock, an id, the network or a source at a slot
 * its parent filled is served the parent's answer. That is the whole reason a
 * fork is a controlled experiment rather than a second run — it runs in the
 * world its parent ran in — and it is a claim about effects the positional
 * comparison has already stopped at, so nothing above was holding it.
 *
 * Matched by key rather than by position, because that is how it is served.
 */
export interface KeptWorld {
  /**
   * Keys both logs served out of the same log and hold the same value at, as
   * `kind:key`. Includes the substituted ones.
   */
  held: readonly string[];
  /** Those of `held` one of the two was told to serve a different value at. */
  excused: readonly string[];
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
  /**
   * The reads above `claimed` that both logs took out of the same log anyway —
   * the world a live tail inherited rather than went and asked for.
   */
  world: KeptWorld;
  /** Set when the two disagree inside `claimed`, or in `world`. */
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

  const world = holdKeptWorld(kinship, left, right, claimed, a, b);
  // The prefix comes first when both are broken: it is the wider claim, and a
  // log whose free prefix is not the prefix it came from is not a log whose
  // live tail is worth reading.
  const contradiction =
    broken === undefined ? world.contradiction : explain(broken, kinship, a, b);

  return {
    a,
    b,
    kinship,
    pairs,
    divergedAt,
    claimed,
    excused: inside.filter(substituted).length,
    world: { held: world.held, excused: world.excused },
    ...(contradiction !== undefined ? { contradiction } : {}),
    ok: contradiction === undefined,
  };
}

/** Kinds a run serves out of a log by key rather than by position. */
const KEYED: ReadonlySet<string> = new Set(DETERMINISTIC_KINDS);

/** One keyed effect and where it sits in its own log's effect sequence. */
interface KeyedAt {
  effect: Effect;
  position: number;
}

/** Every keyed value a log took out of another log, by `kind:key`. */
function keyedReplays(effects: readonly Effect[]): Map<string, KeyedAt> {
  const out = new Map<string, KeyedAt>();
  effects.forEach((effect, position) => {
    if (effect.replayed && KEYED.has(effect.kind)) {
      out.set(`${effect.kind}:${effect.key}`, { effect, position });
    }
  });
  return out;
}

/** Every keyed value a log holds at all — what a parent has to offer a child. */
function keyedValues(effects: readonly Effect[]): Map<string, KeyedAt> {
  const out = new Map<string, KeyedAt>();
  effects.forEach((effect, position) => {
    if (KEYED.has(effect.kind)) out.set(`${effect.kind}:${effect.key}`, { effect, position });
  });
  return out;
}

/**
 * Hold the two logs to the reads their live tails took out of the same log.
 *
 * A child asks its parent's key table, so what it is held to is every keyed
 * value the parent holds, replayed there or not. Two siblings ask the same
 * table as each other, so what they are held to is the keys they *both* served
 * from it — a key only one of them reached is a question only one of them
 * asked, and there is nothing to compare.
 */
function holdKeptWorld(
  kinship: Kinship,
  left: readonly Effect[],
  right: readonly Effect[],
  claimed: number,
  a: RunSummary,
  b: RunSummary,
): KeptWorld & { contradiction?: string } {
  switch (kinship.kind) {
    case "parent": {
      const [child, parent] = kinship.parent === "a" ? [right, left] : [left, right];
      const [childId, parentId] =
        kinship.parent === "a" ? [b.runId, a.runId] : [a.runId, b.runId];
      return holdByKey(
        keyedReplays(child),
        keyedValues(parent),
        claimed,
        (key) =>
          `${key} differs, and ${childId} served it from ${parentId}'s key table above the ` +
          `prefix it replayed — a live tail that did not run in the world it took its reads from`,
      );
    }
    case "siblings":
      return holdByKey(
        keyedReplays(left),
        keyedReplays(right),
        claimed,
        (key) =>
          `${key} differs, and ${a.runId} and ${b.runId} both served it from ${kinship.origin}'s ` +
          `key table above the prefix they replayed — two live tails cannot have read different ` +
          `values out of the same log`,
      );
    // "same" has already held every position, and "unrelated" is two logs with
    // no shared table to have read anything out of.
    default:
      return { held: [], excused: [] };
  }
}

function holdByKey(
  mine: ReadonlyMap<string, KeyedAt>,
  theirs: ReadonlyMap<string, KeyedAt>,
  claimed: number,
  explainKey: (key: string) => string,
): KeptWorld & { contradiction?: string } {
  const held: string[] = [];
  const excused: string[] = [];
  let contradiction: string | undefined;
  for (const [key, at] of mine) {
    const other = theirs.get(key);
    if (other === undefined) continue;
    // Both inside the prefix is a position the positional comparison already
    // held; counting it here would say the live tails shared something they did
    // not reach.
    if (at.position < claimed && other.position < claimed) continue;
    held.push(key);
    if (at.effect.overridden === true || other.effect.overridden === true) {
      excused.push(key);
      continue;
    }
    if (outcomeOf(at.effect) !== outcomeOf(other.effect)) contradiction ??= explainKey(key);
  }
  return { held, excused, ...(contradiction === undefined ? {} : { contradiction }) };
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

  // A read carries its digest in its key too, and unlike a fetch there is no
  // body it could have failed to read: the caller handed the question over
  // whole, so a shared slot is the same source asked the same thing.
  if (l.kind === "read") return { kind: "same" };

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

/** One run in a set being held to the prefix the set shares. */
export interface SharedLog {
  runId: string;
  events: readonly RetraceEvent[];
}

/**
 * Whether a set of runs was a controlled experiment, checked rather than assumed.
 *
 * A set of forks off one run at one fork point are siblings, so `compareEvents`
 * already knows what they owe each other; the only thing left is to say it over
 * a set rather than a pair. It is what separates several forks from several
 * runs: they differ above the fork point and share everything underneath.
 */
export interface SharedPrefix {
  /** How many runs were held against each other. Below two there is nothing to check. */
  runs: number;
  /** Leading effects every run was obliged to hold identically: the free prefix. */
  claimed: number;
  /** Effects inside it a run was told to serve a different value at. */
  excused: number;
  /**
   * Reads above that prefix every one of them took out of the same log: the
   * world their live tails inherited rather than went and asked for. See
   * `KeptWorld` — over a set it is the keys all of them reached, since one only
   * some of them asked says nothing about the rest.
   */
  kept: number;
  /** Set when two of them disagree somewhere they both replayed. */
  contradiction?: string;
  ok: boolean;
}

/**
 * Hold a set of sibling runs to the prefix they all replayed.
 *
 * Comparing each against the first is enough: agreement is transitive, and a
 * disagreement between any two of them shows up against the first as well.
 */
export function holdSharedPrefix(logs: readonly SharedLog[]): SharedPrefix {
  const first = logs[0];
  if (first === undefined || logs.length < 2) {
    return { runs: logs.length, claimed: 0, excused: 0, kept: 0, ok: true };
  }

  let claimed = Number.POSITIVE_INFINITY;
  let kept: Set<string> | undefined;
  let contradiction: string | undefined;
  for (const other of logs.slice(1)) {
    const seen = compareEvents(first.runId, first.events, other.runId, other.events);
    claimed = Math.min(claimed, seen.claimed);
    // Intersected rather than summed or minimised: what the set shares is the
    // keys every pair shares, and a key two of them reached is not a world the
    // third ran in.
    const shared = kept;
    kept =
      shared === undefined
        ? new Set(seen.world.held)
        : new Set(seen.world.held.filter((key) => shared.has(key)));
    contradiction ??= seen.contradiction;
  }

  // Counted over the runs rather than per comparison: a value one of them was
  // told to substitute is one position of the shared prefix that is a
  // substitution, however many pairs it shows up in.
  const substituted = new Set<string>();
  for (const log of logs) {
    for (const effect of effectsOf(log.events).slice(0, claimed)) {
      if (effect.overridden === true) substituted.add(effect.key);
    }
  }

  return {
    runs: logs.length,
    claimed,
    excused: substituted.size,
    kept: kept?.size ?? 0,
    ...(contradiction === undefined ? {} : { contradiction }),
    ok: contradiction === undefined,
  };
}

/**
 * What an effect came back with, as one comparable string. A throw is an
 * outcome as much as a value is — see `verify`, which compares the same way and
 * for the same reason.
 */
function outcomeOf(effect: Effect): string {
  return fingerprint({ value: effect.value, failed: effect.failed ?? null });
}
