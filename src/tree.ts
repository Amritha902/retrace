import { staleFacets, summarize, type RunSummary } from "./replay.ts";
import { RunStore } from "./store.ts";
import type { ForkOrigin, RunStatus } from "./types.ts";

/**
 * How a run re-entered the one above it, as its own log records it.
 *
 * The three are the three commands that produce a run from another run, and
 * they read differently in a family: a fork is a question somebody asked, a
 * resume is a run that was still going, and a replay is a check.
 */
export type Reentry =
  | { kind: "fork"; at: string }
  | { kind: "replay" }
  | { kind: "resume"; after: number; parentStatus: RunStatus };

/** One run, and the runs made from it. */
export interface TreeRun {
  runId: string;
  summary: RunSummary;
  /** Absent on a run that was not made from another run. */
  reentry?: Reentry;
  /** Effect keys this run was told to serve a value for instead of the recorded one. */
  set: string[];
  /** What moved under the prefix it replayed — its own `staleFacets`. */
  moved: string[];
  /** The runs re-entered from this one, oldest first. */
  children: TreeRun[];
}

/** A family: one run every other run in it descends from, and what it all cost. */
export interface RunTree {
  root: TreeRun;
  /**
   * Present when the root names a run this store does not hold, so the family
   * starts where the store does rather than where the lineage does.
   */
  before?: string;
  runs: number;
  billedUsd: number;
  savedUsd: number;
}

export interface Forest {
  trees: RunTree[];
  /**
   * Runs in the store whose logs could not be read. A log too damaged to read
   * is one that cannot say what it came from, so there is nowhere in a family
   * to hang it — named here rather than dropped.
   */
  unreadable: string[];
}

/**
 * Every run in a store, arranged by what was forked, resumed or replayed from
 * what.
 *
 * The workflow this runtime is for is re-entering one run over and over, which
 * leaves a store holding a family rather than a list: forks at three different
 * points, a fork of one of those, the replay that checked it. `ls` prints that
 * flat and in the order the runs happened, which is the one order that hides
 * the shape of it. This is the shape — and beside each run, the thing that run
 * was asking: where it cut, what it was told to substitute, and which
 * components of the request moved underneath the prefix it replayed.
 *
 * Pass a run id for the family that run belongs to, or nothing for every family
 * in the store. Reading a family means reading every log in the store, since a
 * log names the run above it and never the runs below.
 */
export function lineageTrees(store: RunStore = new RunStore(), runId?: string): Forest {
  const held = new Map<string, Held>();
  const unreadable: string[] = [];

  // The run named on the command line is read without the guard below: if its
  // log is the one that cannot be read, that is the caller's error rather than
  // a family quietly missing the run it was asked about.
  if (runId !== undefined) held.set(runId, hold(runId, store));

  for (const id of store.list()) {
    if (held.has(id)) continue;
    try {
      held.set(id, hold(id, store));
    } catch {
      unreadable.push(id);
    }
  }

  const roots =
    runId === undefined
      ? [...held.keys()].filter((id) => parentOf(id, held) === undefined)
      : [rootOf(runId, held)];

  return {
    trees: byStart(roots, held).map((id) => buildTree(id, held)),
    unreadable: unreadable.sort(),
  };
}

interface Held {
  summary: RunSummary;
  moved: string[];
}

function hold(runId: string, store: RunStore): Held {
  const events = store.read(runId);
  return { summary: summarize(runId, events), moved: staleFacets(events) };
}

/** The run this one was made from, when the store holds it. */
function parentOf(runId: string, held: Map<string, Held>): string | undefined {
  const from = held.get(runId)?.summary.forkedFrom;
  return from && held.has(from.runId) ? from.runId : undefined;
}

/** The highest run above this one that the store holds. */
function rootOf(runId: string, held: Map<string, Held>): string {
  const seen = new Set([runId]);
  let at = runId;
  while (true) {
    const up = parentOf(at, held);
    // A log naming a run below itself as its parent is a doctored log, which is
    // `verify`'s business; here it would be a family with no top, so the walk
    // stops the second time it arrives anywhere.
    if (up === undefined || seen.has(up)) return at;
    seen.add(up);
    at = up;
  }
}

function buildTree(runId: string, held: Map<string, Held>): RunTree {
  const root = buildRun(runId, held, new Set());
  const from = root.summary.forkedFrom;
  const tree: RunTree = { root, runs: 0, billedUsd: 0, savedUsd: 0 };
  if (from && !held.has(from.runId)) tree.before = from.runId;

  for (const node of walk(root)) {
    tree.runs += 1;
    tree.billedUsd += node.summary.totals?.billedUsd ?? 0;
    tree.savedUsd += node.summary.totals?.savedUsd ?? 0;
  }
  return tree;
}

function buildRun(runId: string, held: Map<string, Held>, placed: Set<string>): TreeRun {
  const { summary, moved } = held.get(runId)!;
  placed.add(runId);

  const children = byStart(
    [...held.keys()].filter((id) => !placed.has(id) && parentOf(id, held) === runId),
    held,
  );

  const node: TreeRun = {
    runId,
    summary,
    set: summary.forkedFrom?.overrides ?? [],
    moved,
    children: children.map((id) => buildRun(id, held, placed)),
  };
  if (summary.forkedFrom) node.reentry = reentryOf(summary.forkedFrom);
  return node;
}

function reentryOf(from: ForkOrigin): Reentry {
  if (from.resumed) {
    return { kind: "resume", after: from.resumed.after, parentStatus: from.resumed.parentStatus };
  }
  if (from.atStep === "all") return { kind: "replay" };
  return { kind: "fork", at: from.atEffect ?? `step ${from.atStep}` };
}

/** A run and everything below it, depth first, in the order they print. */
export function* walk(node: TreeRun): Generator<TreeRun> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function byStart(ids: string[], held: Map<string, Held>): string[] {
  return [...ids].sort((a, b) => {
    // Two runs recorded in the same millisecond are ordered by id, so a family
    // draws the same way twice however fast it was made.
    const at = held.get(a)!.summary.startedAt;
    const bt = held.get(b)!.summary.startedAt;
    return at === bt ? (a < b ? -1 : 1) : at - bt;
  });
}
