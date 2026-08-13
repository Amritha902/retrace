# Changelog

Notable changes to Retrace. Dates are the date of the release, and versions
follow [semver](https://semver.org) — until 1.0.0, a minor bump is where
breaking changes are allowed to live.

## 0.1.0 — unreleased

First release. Nothing is on npm yet, so this entry describes what the initial
publish contains rather than what changed since something.

### The runtime

- **One journal boundary.** Every model call and tool call goes through
  `journal.effect(kind, key, fn)`. An empty journal executes and appends to an
  append-only JSONL log; a preloaded journal serves from the log without
  executing. Replay is the same loop, not a second implementation of it.
- **`run`, `replay` and `fork`.** `fork(runId, { atStep })` preloads the
  parent's effects below the fork point, so the prefix is free and execution
  goes live from the step that changed. A slot the log disagrees with raises a
  `DivergenceError` naming the effect, unless the caller asks for
  `onDivergence: "live"`.
- **Budgets** in dollars, steps, tool calls, tokens and wall clock, enforced by
  the scheduler — running out is a terminal `budget_exceeded` status with a log
  entry, not an exception thrown from inside a tool.
- **Cost tracked twice.** `costUsd` is list price, `billedUsd` is what was
  actually spent, and `savedUsd` is the gap a replayed prefix opens up.
- **`ctx.now()`, `ctx.uuid()` and `ctx.random()`** are journaled and keyed by
  the call they happened in, so a fork's live steps read the values the parent
  recorded at the same slots.
- **Streaming.** Pass `onStream` and the loop takes the provider's streaming
  path. Fragments never reach the log — the assembled message does — so a run
  recorded with streaming on and one recorded with it off produce identical
  logs, and replayed steps reconstruct their fragments from the log.
- **`parallelTools`,** off by default. Tool bodies overlap; their results are
  journaled in the order the model asked for them, so the log is byte-identical
  to the sequential one.
- **Request digests.** Every model effect records `requestHash`, a digest of the
  model, prompt, tools and conversation that produced it. A step served from the
  log whose digest no longer matches the request the loop just built is marked
  `stale` — expected in a fork below the step you changed, and a sign the loop is
  reading something the journal does not cover if it appears in a plain replay.
  Surfaced by `staleEffects(events)`, by `show`, and by the HTML report.

### The CLI

`retrace ls`, `show`, `cost`, `diff`, `replay`, `fork` and `report`. `replay`
needs nothing but the log and exits non-zero if the run failed to reproduce, so
it works as a regression check on the loop. `fork --module <path>` supplies the
half a log cannot hold — the tools, the provider, and any agent overrides.
`report` writes the run as one self-contained HTML page: no JavaScript, no
network, readable in a light or a dark browser.

### Storage and providers

Runs are JSONL under `.retrace/runs/<run-id>.jsonl`, appended synchronously, so
a process that dies mid-run leaves a truthful prefix — which is enough to fork
from. `MemoryStore` is the same interface with nothing on disk. `AnthropicProvider`
adapts the Messages API, including adaptive thinking, `effort`, server-side
fallbacks, and a byte-for-byte `raw` passthrough that signed thinking blocks
depend on.

### Verified by

120 tests that run with no network and no API key, plus two `[live]` integration
tests that skip themselves when `ANTHROPIC_API_KEY` is unset. GitHub Actions
runs the typecheck, the suite, the build, the demo and a packing dry run on Node
22 and 24 on every push and pull request. The manifest is under test too:
`test/package.test.ts` fails if an entry point names a file the build will not
emit, if `src` imports something an install would not resolve, or if the
changelog stops short of the version `package.json` would publish.
