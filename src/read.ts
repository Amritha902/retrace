import { fingerprint } from "./store.ts";

/**
 * A read a tool declared through `ctx.read`, as the log records it.
 *
 * `ctx.fetch` brings the network inside the journal and the ambient watch says
 * when a tool went around it, which between them cover the reads the runtime
 * can see. What is left is everything a tool asks through something neither
 * reaches: a database driver, a subprocess, a native client, a file. Those are
 * the reads that quietly stop a fork from being a controlled experiment — the
 * prefix comes out of the log and the live tail asks a corpus that has moved —
 * and nothing could be done about them, because the runtime has no way to know
 * such a read happened.
 *
 * This is the tool saying so itself: name the source, say what is being asked,
 * and the answer goes in the log beside the question exactly as a fetch's does.
 * What the journal gains is not detection but coverage — a read it is told
 * about is a read it can serve.
 */
export interface RecordedRead {
  /** What the tool called the thing it read from. */
  source: string;
  /**
   * What was asked, as the caller described it. Recorded beside the answer for
   * the same reason a fetch records its request: without it the line says what
   * came back and never what it came back *to*. Digested into the slot, so a
   * live call asking something else is not handed this answer.
   */
  question: unknown;
  /** What came back. Absent when the read threw — see `error`. */
  value?: unknown;
  /**
   * Set when the read rejected rather than answering. A source that was down is
   * an outcome like any other: a replay that reached it instead would not be a
   * replay of the run that happened.
   */
  error?: { name: string; message: string };
}

/**
 * The slot a read is served from: a digest of the source and the question,
 * appended to its ordinal within the tool call.
 *
 * The ordinal alone is how the clock and the RNG resolve, and for those it is
 * enough — one timestamp is as good as another. An answer is not. Folding the
 * question in means a matching call is served from the log and a call asking
 * something else finds no entry there and reads the world, which is the
 * behaviour you would want either way. It is the same bargain `fetchSlot`
 * makes, with the caller supplying the question instead of the runtime reading
 * it off a request.
 */
export function readSlot(source: string, question: unknown): string {
  return fingerprint({ source, question: question ?? null });
}

/**
 * What the tool sees, live or replayed, from what the log holds.
 *
 * Both passes go through here, so a read that rejected rejects again rather
 * than coming back as an undefined value — and a tool cannot behave one way
 * while it is being recorded and another way afterwards.
 */
export function resolveRead(recorded: RecordedRead): unknown {
  if (recorded.error) {
    const error = new Error(recorded.error.message);
    error.name = recorded.error.name;
    throw error;
  }
  return recorded.value;
}

/** How a read reads in `show` and in the HTML report. */
export function describeRead(recorded: RecordedRead): string {
  const asked = `${recorded.source}${describeQuestion(recorded.question)}`;
  if (recorded.error) return `${asked} → ${recorded.error.name}: ${recorded.error.message}`;
  return `${asked} → ${render(recorded.value)}`;
}

/**
 * The question, where there is one. A read of something that takes no argument
 * passes `null` and the line is the source and its answer, which is what a
 * reader wants for a config file or a machine name.
 */
function describeQuestion(question: unknown): string {
  if (question === null || question === undefined) return "";
  return ` ${render(question)}`;
}

/** A recorded value as one line: text as itself, anything else as JSON. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "undefined";
}
