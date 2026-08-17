import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Somewhere a tool can get a time, an id, a random draw or an answer off the
 * network without going through the journal. `ctx.now()` and its siblings are
 * recorded and come back unchanged on a replay; `Date.now()` reads the real
 * clock every time, and a bare `fetch` reaches the world every time.
 */
export const AMBIENT_SOURCES = ["clock", "random", "uuid", "network"] as const;

export type AmbientSource = (typeof AMBIENT_SOURCES)[number];

/**
 * The real implementations, captured before anything is wrapped, so retrace's
 * own reads of the clock and the RNG never look like a tool's.
 */
const REAL_DATE = globalThis.Date;
const REAL_NOW = globalThis.Date.now;
const REAL_RANDOM = globalThis.Math.random;
const REAL_UUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);

/** The clock and the RNG as the journal itself reads them: unwatched. */
export const realNow = (): number => REAL_NOW();
export const realRandom = (): number => REAL_RANDOM();

/**
 * Which tool call is running right now, and what it has reached for.
 *
 * An async-local store rather than a flag, because `parallelTools` has several
 * bodies in flight at once and a read has to land against the one that made it.
 * Code running outside any tool — the loop, the store, the journal's own
 * timings — finds no store here and is not noticed.
 */
const running = new AsyncLocalStorage<Set<AmbientSource>>();

/** How many tool bodies are in flight; the wrappers come down at zero. */
let watching = 0;

/**
 * The `fetch` in place when the watch went up.
 *
 * Captured at install rather than at load, unlike the clock and the RNG. Those
 * are language built-ins and retrace's own reads of them must never look like a
 * tool's; `fetch` is routinely replaced — by a test, by a proxy, by an
 * instrumentation library — and restoring the one from module load would undo
 * somebody else's substitution as a side effect of running a tool.
 */
let realFetch: typeof globalThis.fetch;

function note(source: AmbientSource): void {
  running.getStore()?.add(source);
}

/**
 * Run something outside the watch, so what it reaches for is not attributed to
 * the tool that caused it.
 *
 * `ctx.fetch` is the caller: it goes through the journal, which is the opposite
 * of the thing being looked for, and it reaches the network through the same
 * global the watch has wrapped. Leaving the async-local store is what tells the
 * two apart — and it costs nothing, because a read the journal covers is
 * already recorded where it matters.
 */
export function unwatched<T>(body: () => T): T {
  return running.exit(body);
}

/**
 * Run a tool body with the ambient clock, id source, RNG and `fetch` under
 * observation, and report which of them it touched.
 *
 * This is the one hole in the determinism guarantee that the log could not
 * otherwise close: a tool that stamps `Date.now()` into what it returns records
 * a snapshot, and a fork replaying that answer is reading a value the tool would
 * not produce again. `recheck` can find it by executing the call twice; this
 * finds it while the call is being recorded, for nothing.
 *
 * The wrappers delegate to the real implementations and only observe, so a run
 * with this on computes exactly what a run without it would. What it does cost
 * is the identity of `globalThis.Date` for the moments a tool body is running:
 * `new Date()` produces a subclass instance so the zero-argument form can be
 * told from `new Date(ms)`, which is a value and reads no clock.
 */
export async function watchAmbient<T>(
  body: () => Promise<T>,
): Promise<{ value: T; ambient: AmbientSource[] }> {
  const seen = new Set<AmbientSource>();
  install();
  try {
    const value = await running.run(seen, body);
    return { value, ambient: AMBIENT_SOURCES.filter((s) => seen.has(s)) };
  } finally {
    uninstall();
  }
}

/**
 * A `Date` that can tell a clock read from a value.
 *
 * `new Date(1700000000000)` is arithmetic on a number the caller already had;
 * only the zero-argument form asks the machine what time it is. Extending the
 * real `Date` keeps every method and static working, and `hasInstance` is
 * delegated so that a `Date` made before the wrapper went up — or after it came
 * down — still answers `instanceof Date` while a tool is running.
 */
class WatchedDate extends REAL_DATE {
  constructor(...args: unknown[]) {
    if (args.length === 0) note("clock");
    super(...(args as []));
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof REAL_DATE;
  }
}

function install(): void {
  if (watching++ > 0) return;
  // On the real `Date` as well as on the global, so code holding a reference
  // taken before the swap is watched too.
  REAL_DATE.now = () => {
    note("clock");
    return REAL_NOW();
  };
  globalThis.Date = WatchedDate as unknown as DateConstructor;
  globalThis.Math.random = () => {
    note("random");
    return REAL_RANDOM();
  };
  // An own property shadowing the one on `Crypto.prototype`. `randomUUID`
  // imported from `node:crypto` is a different binding and cannot be reached
  // from here — see the caveat in the README.
  globalThis.crypto.randomUUID = () => {
    note("uuid");
    return REAL_UUID();
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    note("network");
    return realFetch(input, init);
  };
}

function uninstall(): void {
  if (--watching > 0) return;
  REAL_DATE.now = REAL_NOW;
  globalThis.Date = REAL_DATE;
  globalThis.Math.random = REAL_RANDOM;
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  globalThis.fetch = realFetch;
}
