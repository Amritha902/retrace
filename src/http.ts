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
  request: RecordedRequest;
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
 * What a call to `ctx.fetch` is asking, as the log records it.
 *
 * The body is here for the same reason the response body is: a `POST` recorded
 * as its method and its URL says the run charged something and never what, and
 * the slot it is served from is a digest of this — so a request the log cannot
 * hold is a request the key cannot tell apart from another.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  /** The body, as text where the bytes are text and base64 where they aren't. */
  body?: string;
  /** Set when `body` is base64 rather than the bytes themselves. */
  base64?: true;
  /**
   * Set when there was a body and reading it would have taken it from the
   * fetch about to send it. The journal observes a request; it does not rewrite
   * one, so a stream stays the caller's to send and the log says it did not
   * read it rather than recording an empty body.
   */
  unread?: true;
}

/**
 * What `fetch` accepts as its first argument. Spelled out rather than taken
 * from `RequestInfo`, which is a DOM name and not in the libs this compiles
 * against.
 */
export type FetchInput = string | URL | Request;

/** What a call to `ctx.fetch` is asking, as the log records it. */
export async function requestOf(
  input: FetchInput,
  init?: RequestInit,
): Promise<RecordedRequest> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return { method, url, ...(await readBody(input, init)) };
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
 *
 * Headers are deliberately not in it. A request id, a trace header or a token
 * that is reissued between runs would move the slot on every call and send a
 * replay to the network for all of them, which costs the guarantee to catch a
 * difference that rarely changes the answer.
 */
export function fetchSlot(request: RecordedRequest): string {
  return fingerprint({
    method: request.method,
    url: request.url,
    body: request.body ?? null,
    ...(request.base64 ? { base64: true } : {}),
    ...(request.unread ? { unread: true } : {}),
  });
}

/**
 * The body a call is sending, where it is something that can be read without
 * consuming it.
 *
 * A string, a `URLSearchParams`, bytes and a `Blob` can all be read twice, so
 * reading one here leaves the fetch below exactly the request it was given. A
 * stream cannot, and form data has no stable bytes to record — the boundary is
 * generated per request — so both are marked `unread` instead. That is still
 * worth recording: a slot carrying `unread` cannot collide with the bodyless
 * call to the same URL, only with another unread one.
 */
async function readBody(
  input: FetchInput,
  init: RequestInit | undefined,
): Promise<Partial<RecordedRequest>> {
  const given = init?.body;
  if (given === undefined) {
    // No body in `init` means the one on the `Request`, if there is one. Reading
    // it needs a clone, which tees the stream and leaves the original sendable.
    if (input instanceof Request && input.body)
      return encodeBody(new Uint8Array(await input.clone().arrayBuffer()));
    return {};
  }
  if (given === null) return {};
  if (typeof given === "string") return { body: given };
  if (given instanceof URLSearchParams) return { body: given.toString() };
  if (given instanceof Blob) return encodeBody(new Uint8Array(await given.arrayBuffer()));
  if (given instanceof ArrayBuffer) return encodeBody(new Uint8Array(given));
  if (ArrayBuffer.isView(given))
    return encodeBody(new Uint8Array(given.buffer, given.byteOffset, given.byteLength));
  return { unread: true };
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
  const what = `${recorded.request.method} ${recorded.request.url}${describeSent(recorded.request)}`;
  if (recorded.error) return `${what} → ${recorded.error.name}: ${recorded.error.message}`;
  return `${what} → ${recorded.status}${sizeOf(recorded)}`;
}

/** What a request carried, at the size the timeline has room for. */
function describeSent(request: RecordedRequest): string {
  if (request.unread) return " (body not read)";
  if (request.body === undefined) return "";
  return sizeOf(request as { body: string; base64?: true });
}

/** A body as a byte count, so the two halves of the line mean the same thing. */
function sizeOf(held: { body: string; base64?: true }): string {
  const bytes = held.base64
    ? Buffer.from(held.body, "base64").length
    : Buffer.byteLength(held.body);
  return ` (${bytes}B${held.base64 ? " binary" : ""})`;
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
