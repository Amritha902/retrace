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
- **`resume`.** A run killed partway through is carried on from its log: the
  whole prefix replays and execution goes live at the effect the log ends on, so
  a process that died at step 9 of 12 finishes for the price of three steps. It
  is a fork whose fork point is wherever the log stops. A run that ended with an
  answer is refused rather than re-run, and one that stopped at a limit stops
  there again unless the limit moves. The new run's log records what it resumed
  from and the state that parent was in.
- **Budgets** in dollars, steps, tool calls, tokens and wall clock, enforced by
  the scheduler — running out is a terminal `budget_exceeded` status with a log
  entry, not an exception thrown from inside a tool.
- **Cost tracked twice.** `costUsd` is list price, `billedUsd` is what was
  actually spent, and `savedUsd` is the gap a replayed prefix opens up.
- **`ctx.now()`, `ctx.uuid()` and `ctx.random()`** are journaled and keyed by
  the call they happened in, so a fork's live steps read the values the parent
  recorded at the same slots.
- **A model call that throws is an outcome, not a gap.** The failure is
  recorded where the value would have gone, as `failed: { name, message }`, so a
  run that died on a 529 replays into the same error without calling anything.
  Previously the log held only the calls that worked, so a replay ran off the
  end of it and made the call live — and if that call succeeded, a failed run
  came back `completed` and looked like a reproduction. A replay raises
  `ReplayedFailure` carrying the recorded message and the original error's name;
  the class is not reconstructed, because a log is JSON. `resume` is the
  deliberate exception: it drops the trailing failure and retries that call,
  which is what resuming a broken run is for. An override on the effect that
  threw hands it the answer it never gave. `verify` compares outcomes rather
  than values, so a log that turns a recorded throw into an answer fails
  `parent`, and one that records work after a throw fails `shape`.
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
- **…and which part of the request moved.** Alongside `requestHash`, each model
  effect records `requestFacets`: the same digest taken one component at a time —
  `model`, `system`, `tools`, `conversation`, `settings`. A stale step records
  the ones that disagree, so `show` reads `stale (system)` where a rewritten
  prompt is the cause and `stale (conversation)` where an overridden value is,
  and a fork reporting `system, tools` is telling you the module you passed does
  not declare the tools the run was recorded with. Surfaced by
  `staleFacets(events)`, by `show`, `replay`, `fork`, `resume`, `verify` and the
  HTML report. Staleness itself is still decided by the whole-request digest, so
  a log written before this compares exactly as it did and reports `stale` with
  nothing named rather than naming something it never checked.
- **Tool calls carry a digest too,** of the input they were called with, under
  the facet `input`. A tool's input normally comes out of a model response that
  itself came out of the log, so in an ordinary fork there is nothing to see —
  which is why it was left unstamped at first, and why that was wrong. Replace a
  model response and the tool call below it still lands in the same slot, is
  still served from the log, and is now the parent's answer to the parent's
  question; hand-edit or splice a log and the same thing happens. Both are now
  marked `stale (input)` rather than passing silently. The tool's name is
  deliberately not in the digest: a call to a different tool lands in a different
  slot and is a `DivergenceError`. Logs whose tool calls predate this compare as
  they always did and are reported clean rather than guessed at.
- **Value overrides.** `fork(runId, { overrides: { "step:2#0:search": "no
  results" } })` serves a value the parent never recorded, so the live steps
  answer a changed world. The substituted effect is logged `overridden`, and the
  replayed steps below it go `stale` off the same request digest — a
  counterfactual that says how much of itself is still the old answer. An
  override naming an effect the log lacks, or one at a step the fork runs live,
  is an error rather than a silent no-op.

- **`verifyRun(runId)`.** Holds a log to the claims it makes about itself, from
  the logs alone — no provider, no tools, no network. The effect sequence is
  dense and in order; the charges add up to the totals the run reports; nothing
  served from the log was billed or claims to have taken time; nothing that
  executed is marked `stale` or `overridden`. And, for a fork, every effect it
  served from the log is looked up in the run it says it came from and compared
  value for value — the claim a fork's own log cannot make, and the one the free
  prefix rests on. Then `lineage` follows each of those effects the rest of the
  way up: through a fork of a fork of a fork, comparing values at every hop,
  until it reaches the run that executed and was billed for it. A free prefix
  with no parent to have come from, a value doctored in the middle of a lineage —
  which agrees with its child and only disagrees with the run that produced it —
  and a run that is its own ancestor all fail there and nowhere else. A check
  with nothing to run against comes back skipped rather than passed, and a
  lineage that leaves the store is traced as far as it goes.
- **`recheckRun(runId, { tools })`.** The other half of `verify`, and the only
  thing here that reaches the world on purpose: it puts each recorded tool call
  back to the tool as it is today — with the input the model supplied at the
  time, read off the model response that asked for it — and compares the answer
  to what the log holds. `verify` can prove a fork's free prefix is its parent's;
  only this can say the prefix is still *true*, which is what makes it worth
  replaying. The model is never called. Calls are handed the clock, ids and
  randomness the log recorded at the same slots, so a tool that reads those from
  `ctx` is compared on what it said rather than on when. A call naming a tool the
  module no longer exports, one narrowed out by `only`, and one holding a value
  an override substituted are each counted apart rather than folded into a pass —
  the report is `ok` when nothing moved and `complete` only when everything ran.
- **A substituted value is marked on the run that was told to substitute it,**
  and not on its descendants. A fork of a counterfactual inherits the value like
  any other recorded value; the `overridden` mark stays in the log where the
  instruction was given, and `lineage` is what finds it from further down.

### The CLI

`retrace ls`, `show`, `cost`, `diff`, `replay`, `fork`, `resume`, `report`,
`verify` and `recheck`.
`replay` needs nothing but the log and exits non-zero if the run failed to
reproduce, so it works as a regression check on the loop. `fork --module <path>`
and `resume --module <path>` supply the half a log cannot hold — the tools, the
provider, and any agent overrides.
`--set <effect-key>=<value>`, on `fork` and `replay`, is the counterfactual.
`report` writes the run as one self-contained HTML page: no JavaScript, no
network, readable in a light or a dark browser. `verify` prints one line per
check and exits non-zero on a failure, so it can gate a pipeline. `recheck
--module <path>` does the same for the tools, printing both answers where one
has moved; `--tool <name>` is repeatable and keeps it away from the tools that
should not run twice.

### Storage and providers

Runs are JSONL under `.retrace/runs/<run-id>.jsonl`, appended synchronously, so
a process that dies mid-run leaves a truthful prefix — which is enough to fork
from, or to resume. A line torn in half by the kill is dropped on read; a broken
line anywhere else is still an error. `MemoryStore` is the same interface with
nothing on disk. `AnthropicProvider`
adapts the Messages API, including adaptive thinking, `effort`, server-side
fallbacks, and a byte-for-byte `raw` passthrough that signed thinking blocks
depend on.

### Verified by

202 tests that run with no network and no API key, plus two `[live]` integration
tests that skip themselves when `ANTHROPIC_API_KEY` is unset. GitHub Actions
runs the typecheck, the suite, the build, the demo and a packing dry run on Node
22 and 24 on every push and pull request. The manifest is under test too:
`test/package.test.ts` fails if an entry point names a file the build will not
emit, if `src` imports something an install would not resolve, or if the
changelog stops short of the version `package.json` would publish.
