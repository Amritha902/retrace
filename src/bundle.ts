import { fingerprint, RunStore } from "./store.ts";
import type { ForkOrigin, RetraceEvent } from "./types.ts";

/**
 * A run and every run it was forked from, as one file.
 *
 * `verify` proves a fork's free prefix is the prefix its parent recorded, and
 * follows the chain up to the run that executed and paid for it — but only
 * through logs the store holds. A lineage that leaves the store is traced to
 * that point and reported skipped, which is the honest answer and a useless one
 * the moment the run has to be checked somewhere else: the machine reading it
 * has one log and no way to reach the runs that account for what it got free.
 *
 * A bundle is that chain, collected where it is whole. Import it and the check
 * that had nothing to run against runs complete.
 */

const FORMAT = "retrace.bundle";
const VERSION = 1;

export interface BundledRun {
  runId: string;
  events: RetraceEvent[];
}

export interface Bundle {
  /** The run this was collected for. */
  root: string;
  /** The root first, then each ancestor, nearest first. */
  runs: BundledRun[];
  /** True when the chain reaches a run that was forked from nothing. */
  complete: boolean;
  /** Why the walk stopped short of such a run. Set when `complete` is false. */
  incomplete?: string;
}

export interface ImportReport {
  root: string;
  /** Runs written into the store, oldest ancestor first. */
  added: string[];
  /** Runs the store already held, event for event. */
  present: string[];
  complete: boolean;
  incomplete?: string;
}

/**
 * Walk a run's ancestry, collecting every log on the way.
 *
 * A chain the store cannot follow to its end comes back marked rather than
 * refused: a partial bundle still carries more lineage than the log alone, and
 * saying how far it goes is the same answer `verify` gives.
 */
export function collectBundle(runId: string, store: RunStore = new RunStore()): Bundle {
  const runs: BundledRun[] = [];
  const seen = new Set<string>();
  let next: string | undefined = runId;

  while (next !== undefined) {
    if (seen.has(next)) {
      throw new Error(`"${next}" is its own ancestor, which no sequence of forks produces`);
    }
    seen.add(next);

    // An ancestor this store lacks is the gap a bundle exists to describe; the
    // root itself missing is a mistake in the command, and `read` says so.
    if (next !== runId && !store.exists(next)) {
      return { root: runId, runs, complete: false, incomplete: `"${next}" is not in this store` };
    }

    const events = store.read(next);
    runs.push({ runId: next, events });
    next = originOf(events)?.runId;
  }

  return { root: runId, runs, complete: true };
}

/**
 * One event per line, the way a run log is written, under a header naming what
 * the file carries. A bundle of a long lineage is then a file that streams and
 * diffs like the logs inside it, rather than a handful of enormous lines.
 */
export function serializeBundle(bundle: Bundle): string {
  const header = {
    format: FORMAT,
    version: VERSION,
    root: bundle.root,
    runs: bundle.runs.map((r) => r.runId),
    complete: bundle.complete,
    ...(bundle.incomplete !== undefined ? { incomplete: bundle.incomplete } : {}),
  };

  const lines = [JSON.stringify(header)];
  for (const run of bundle.runs) {
    for (const event of run.events) lines.push(JSON.stringify({ run: run.runId, event }));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Read a bundle back.
 *
 * Unlike a run log, this file came from somewhere else, so its shape is checked
 * rather than assumed — a truncated or hand-edited bundle that imported quietly
 * would put logs into the store that nothing in the store accounts for.
 */
export function parseBundle(text: string): Bundle {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("bundle is empty");

  const header = parseLine(lines[0]!, 1);
  if (header["format"] !== FORMAT) {
    throw new Error(`not a retrace bundle: line 1 is not a ${FORMAT} header`);
  }
  if (header["version"] !== VERSION) {
    throw new Error(
      `bundle is version ${JSON.stringify(header["version"])}, and this retrace reads version ${VERSION}`,
    );
  }

  const root = header["root"];
  if (typeof root !== "string") throw new Error("bundle header names no root run");

  const order = header["runs"];
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
    throw new Error("bundle header does not list the runs it carries");
  }
  if (!order.includes(root)) {
    throw new Error(`bundle header names "${root}" as its root and does not list it among its runs`);
  }

  const collected = new Map<string, RetraceEvent[]>(order.map((id) => [id, []]));
  for (const [i, line] of lines.slice(1).entries()) {
    const lineNo = i + 2;
    const record = parseLine(line, lineNo);
    const runId = record["run"];
    if (typeof runId !== "string" || record["event"] === undefined) {
      throw new Error(`bundle line ${lineNo} is not a "run" and "event" pair`);
    }
    const into = collected.get(runId);
    if (into === undefined) {
      throw new Error(
        `bundle line ${lineNo} carries an event for "${runId}", which its header does not list`,
      );
    }
    into.push(record["event"] as RetraceEvent);
  }

  const runs = order.map((id) => ({ runId: id, events: collected.get(id)! }));
  const empty = runs.find((r) => r.events.length === 0);
  if (empty !== undefined) {
    throw new Error(`bundle lists "${empty.runId}" and carries no events for it`);
  }

  return {
    root,
    runs,
    complete: header["complete"] === true,
    ...(typeof header["incomplete"] === "string" ? { incomplete: header["incomplete"] } : {}),
  };
}

/**
 * Write a bundle's runs into a store.
 *
 * A run the store already holds is left alone if it matches and refused if it
 * does not. Overwriting would let a bundle rewrite a log that other runs have
 * already been verified against — the exact doctoring `verify`'s parent and
 * lineage checks exist to catch, arriving through the front door.
 */
export function importBundle(bundle: Bundle, store: RunStore = new RunStore()): ImportReport {
  const added: string[] = [];
  const present: string[] = [];

  // Oldest first, so an import that dies partway leaves a store whose forks can
  // still reach their parents rather than one whose cannot.
  for (const run of [...bundle.runs].reverse()) {
    if (store.exists(run.runId)) {
      if (fingerprint(store.read(run.runId)) !== fingerprint(run.events)) {
        throw new Error(
          `"${run.runId}" is already in ${store.dir} and is not the run this bundle carries — ` +
            `import into a different store rather than deciding which of them is true`,
        );
      }
      present.push(run.runId);
      continue;
    }
    for (const event of run.events) store.append(run.runId, event);
    added.push(run.runId);
  }

  return {
    root: bundle.root,
    added,
    present,
    complete: bundle.complete,
    ...(bundle.incomplete !== undefined ? { incomplete: bundle.incomplete } : {}),
  };
}

function originOf(events: readonly RetraceEvent[]): ForkOrigin | undefined {
  const started = events.find((e) => e.type === "run.started");
  return started?.type === "run.started" ? started.forkedFrom : undefined;
}

function parseLine(line: string, lineNo: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`bundle line ${lineNo} is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`bundle line ${lineNo} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
