import { fingerprint } from "./store.ts";

/**
 * A response, flattened into something a JSONL line can hold.
 *
 * The log has to survive the objects it was written from — a `Response` is a
 * one-shot stream over a socket that is closed by the time anyone replays it —
 * so what goes in is the parts a tool can actually read back out. The request is
 * recorded beside the response for the same reason a tool call records its
 * input: without it the line says `200` and not what it is 200 *to*.
 */
export interface RecordedFetch {
  request: { method: string; url: string };
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The body, as text where the bytes are text and base64 where they aren't. */
  body: string;
  /** Set when `body` is base64 rather than the bytes themselves. */
  base64?: true;
  /**
   * Set when the fetch rejected rather than answering. A network error is an
   * outcome like any other and a replay has to reproduce it, or a run that died
   * because a host was down replays into one that reached it.
   */
  error?: { name: string; message: string };
}

/**
 * What `fetch` accepts as its first argument. Spelled out rather than taken
 * from `RequestInfo`, which is a DOM name and not in the libs this compiles
 * against.
 */
export type FetchInput = string | URL | Request;

/** What a call to `ctx.fetch` is asking, as the log records it. */
export function requestOf(input: FetchInput, init?: RequestInit): RecordedFetch["request"] {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return { method, url };
}

/**
 * The slot a fetch is served from: its ordinal within the tool call, and a
 * digest of what it is asking.
 *
 * The ordinal alone is how the clock and the RNG resolve, and for those it is
 * enough — one timestamp is as good as another. A response is not: serving the
 * body of `?q=pricing` to a call that asked `?q=cost` would be a wrong answer
 * rather than a stale one. Folding the request into the key means a matching
 * call is served from the log and a different one simply finds no entry there
 * and goes to the network, which is the behaviour you would want either way.
 */
export function fetchSlot(request: RecordedFetch["request"], body: string | undefined): string {
  return `${fingerprint({ ...request, body: body ?? null })}`;
}

/**
 * The body of a request, where it is text. Anything else — a stream, a blob,
 * form data — is left out of the digest rather than guessed at, so two calls
 * that differ only in such a body share a slot. `ctx.fetch` says so.
 */
export function bodyDigestOf(init: RequestInit | undefined): string | undefined {
  return typeof init?.body === "string" ? init.body : undefined;
}

/** Drain a live response into something the log can hold. */
export async function captureFetch(
  request: RecordedFetch["request"],
  response: Response,
): Promise<RecordedFetch> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name] = value;

  return {
    request,
    status: response.status,
    statusText: response.statusText,
    headers,
    ...encodeBody(bytes),
  };
}

/** The same, for a fetch that rejected. */
export function captureFetchFailure(
  request: RecordedFetch["request"],
  cause: unknown,
): RecordedFetch {
  const error =
    cause instanceof Error
      ? { name: cause.name, message: cause.message }
      : { name: "Error", message: String(cause) };
  return { request, status: 0, statusText: "", headers: {}, body: "", error };
}

/**
 * Build the `Response` a tool sees, live or replayed, from what the log holds.
 *
 * Both sides go through here so the two are the same object: a live call whose
 * body has already been drained cannot hand back the original response, and a
 * tool that behaved differently on the recording pass than on the replay pass
 * would be a difference the journal introduced rather than one it caught.
 */
export function rebuildResponse(recorded: RecordedFetch): Response {
  if (recorded.error) {
    const error = new Error(recorded.error.message);
    error.name = recorded.error.name;
    throw error;
  }

  // A 204 or a 304 is not allowed to carry a body at all, and an empty body is
  // indistinguishable from no body once it is in the log.
  const body = recorded.body === "" ? null : decodeBody(recorded);
  const response = new Response(body, {
    status: recorded.status,
    statusText: recorded.statusText,
    headers: recorded.headers,
  });
  // `url` has no constructor option and is a getter on the prototype; an own
  // property shadows it, so `response.url` reads back what was fetched.
  Object.defineProperty(response, "url", { value: recorded.request.url, enumerable: true });
  return response;
}

/** How a fetch reads in `show` and in the HTML report. */
export function describeFetch(recorded: RecordedFetch): string {
  const what = `${recorded.request.method} ${recorded.request.url}`;
  if (recorded.error) return `${what} → ${recorded.error.name}: ${recorded.error.message}`;
  const size = recorded.base64 ? "" : ` (${recorded.body.length}B)`;
  return `${what} → ${recorded.status}${size}`;
}

/**
 * Text where the bytes are valid UTF-8, base64 where they aren't.
 *
 * A log that is worth reading is half of what everything here is built on, and
 * base64ing every JSON body to accommodate the occasional image would cost that
 * for nothing. Deciding by whether the bytes decode is the only test that never
 * mangles anything: a body that survives the round trip goes in as itself.
 */
function encodeBody(bytes: Uint8Array): { body: string; base64?: true } {
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { body: Buffer.from(bytes).toString("base64"), base64: true as const };
  }
}

function decodeBody(recorded: RecordedFetch): Uint8Array {
  return recorded.base64
    ? new Uint8Array(Buffer.from(recorded.body, "base64"))
    : new TextEncoder().encode(recorded.body);
}
