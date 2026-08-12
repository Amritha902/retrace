import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RetraceEvent } from "./types.ts";

export const DEFAULT_STORE_DIR = ".retrace";

/**
 * Runs are JSONL files on disk, one event per line, appended synchronously as
 * the run proceeds. Synchronous is deliberate: if the process dies mid-run the
 * log is still a truthful prefix of what happened, and that prefix is enough to
 * fork from.
 */
export class RunStore {
  readonly dir: string;
  private ensured = false;

  constructor(baseDir: string = DEFAULT_STORE_DIR) {
    this.dir = join(baseDir, "runs");
  }

  private path(runId: string): string {
    return join(this.dir, `${runId}.jsonl`);
  }

  append(runId: string, event: RetraceEvent): void {
    if (!this.ensured) {
      // Created on first write, so constructing a store never touches the disk.
      mkdirSync(this.dir, { recursive: true });
      this.ensured = true;
    }
    appendFileSync(this.path(runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  exists(runId: string): boolean {
    return existsSync(this.path(runId));
  }

  read(runId: string): RetraceEvent[] {
    const file = this.path(runId);
    if (!existsSync(file)) {
      throw new Error(`no run "${runId}" in ${this.dir}`);
    }
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, i) => {
        try {
          return JSON.parse(line) as RetraceEvent;
        } catch {
          throw new Error(`run "${runId}" has a corrupt event on line ${i + 1}`);
        }
      });
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  }
}

/** In-memory store for tests and for callers who don't want anything on disk. */
export class MemoryStore extends RunStore {
  private runs = new Map<string, RetraceEvent[]>();

  constructor() {
    // Base constructor needs a directory; it is never written to because every
    // method below is overridden.
    super(join(process.env["TMPDIR"] ?? "/tmp", `retrace-mem-${randomUUID()}`));
  }

  override append(runId: string, event: RetraceEvent): void {
    const existing = this.runs.get(runId);
    if (existing) existing.push(event);
    else this.runs.set(runId, [event]);
  }

  override exists(runId: string): boolean {
    return this.runs.has(runId);
  }

  override read(runId: string): RetraceEvent[] {
    const events = this.runs.get(runId);
    if (!events) throw new Error(`no run "${runId}" in memory`);
    return events;
  }

  override list(): string[] {
    return [...this.runs.keys()].sort();
  }
}

/**
 * Run ids sort chronologically and carry a short random suffix, so `ls` is
 * ordered by time without reading a single file.
 */
export function newRunId(prefix = "run"): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  return `${prefix}_${stamp}_${suffix}`;
}

/** Stable fingerprint of an agent spec, for spotting "same run, different config". */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}
