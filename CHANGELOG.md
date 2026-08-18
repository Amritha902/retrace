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
- **Fork points inside a step.** `fork(runId, { atEffect: "step:2#2:search" })`,
  or `retrace fork … --at 'step:2#2:search'`, cuts the log between two calls
  rather than between two steps: everything recorded before that call replays,
  including the model turn that asked for it, and execution goes live at the
  call itself. It is the move `recheck` leaves you wanting — re-run the call the
  world moved under, without paying for the steps below it or losing the turn
  that asked. Only model and tool calls can be fork points; naming a clock, id
  or random read is an error, since those resolve by key and are served wherever
  the run reaches them. The log records both `atStep` and `atEffect`, and
  `verify` holds the fork to the finer of the two.
- **`planFork`.** What a fork would do, read off the log before any of it is
  paid for: how many effects come out of the log and what they would not spend
  again, which replayed calls would come back `stale` and on which components,
  which tools the log says the run declared that the module does not, and which
  calls in the fork point's own step a tool marks `irreversible`. It is derived
  the way the fork derives it — the same cut, the same rebuilt requests, the same
  recorded digests — so the `stale` line it prints is the line the fork will
  print. Nothing executes; there is no provider to give it. Above the fork point
  it describes nothing, because the model has not been asked yet, and without
  tools it reports the staleness unpredicted rather than guessing at it.
- **`searchForkPoints`.** The question `fork` can only answer one point at a
  time: how far down a change has to go before it takes. It walks a run's fork
  points downward from its last step, forking at each and stopping at the first
  whose answer satisfies the predicate — by default an answer that is not the
  recorded one, or a regular expression given as `until`. Downward is what makes
  it cheap: the highest fork point has the most of the run already paid for, so
  a deeper prefix is only paid for once a shallower one is ruled out. Every
  trial is a real run in the store, and the report totals what the search billed
  against what the same trials would have cost as full re-runs. `from`, `downTo`
  and `maxForks` bound it; a fork that did not complete is never a match; and a
  search carrying overrides stops at the step below which the substituted value
  would no longer be served, rather than walking into `fork`'s refusal.
  `repeat` cuts each fork point more than once, because one fork is one draw and
  a model that would have moved the answer on its own is otherwise
  indistinguishable from a change taking: a fork point holds only if every fork
  made at it satisfies the predicate, one that answered both ways is reported
  `unstable` and is not a finding, and the forks of each fork point are held to
  the prefix they all replayed, so the model is the only thing a difference
  between them can be about. `maxForks` counts forks rather than fork points, so
  a cap that cannot afford a whole fork point does not try half of one.
- **`sweepForkPoint`.** The other half of the same question: fix the fork point
  and vary the change. It forks a run once per arm — an arm being an agent to
  change, a value to substitute, or an input to replace — so five prompts tried
  at step 7 of a twelve-step run cost five live tails rather than five runs, and
  the report totals what that saved. Every arm is a real run in the store, and
  each carries the components its own change moved, so the report says which arm
  rewrote the prompt and which rewrote the world. The claim a sweep makes over
  running the agent once per arm is that the arms are a controlled experiment,
  and it is checked rather than asserted: the arms are siblings, `compareRuns`
  already knows what siblings owe each other, and the report says how many
  effects every arm replayed identically and how many of those were values an
  arm was told to substitute. An arm the runtime refuses — an override this fork
  point would serve to nobody is the one that happens — is reported `not_run`
  with the reason, and the other arms still run.
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
- **`ctx.fetch` journals the network**, which was the largest nondeterministic
  thing a tool did that the log could not follow. The response is flattened into
  the log — status, status text, headers, body as text where the bytes are text
  and base64 where they are not — and rebuilt on the way back out, so a live
  call and a replayed one hand a tool the same `Response`, `url` included. A
  rejection is recorded and thrown again, so a run that died because a host was
  down does not replay into one that reached it. Its slot resolves by key rather
  than by position, like the clock and the RNG, which means the live tail of a
  fork sees the world its parent saw and differs from it only in what you
  changed. What keeps that from being a cache that lies is a digest of the
  method, URL and body folded into the key: a call asking something else
  finds nothing in that slot and goes to the network rather than being handed
  the wrong answer. The request is flattened into the log the same way the
  response is, body and all, so a `POST` says what was posted rather than only
  where — a string, form parameters, bytes and a `Blob` can each be read twice,
  so digesting one leaves the fetch below the request it was given, while a
  `ReadableStream` and `FormData` are recorded `unread` rather than drained or
  guessed at. Headers are outside the digest on purpose: a trace header or a
  reissued token would move every slot and send a whole replay to the network.
  `recheck` is the deliberate exception and does not serve
  recorded responses — whether the world still says what the log holds is the
  question it exists to ask — so its network reads go live while the clock, the
  ids and the randomness stay pinned, leaving the network as the only thing a
  disagreement can be about.
- **`ctx.read` journals everything else.** `ctx.fetch` covers the network
  because the runtime can intercept it; a database driver, a subprocess or a
  native HTTP client is somewhere no wrapper reaches, and until now there was no
  way to bring one inside the journal even deliberately. `ctx.read(source,
  question, fn)` is the tool saying so itself: the answer is executed once,
  recorded beside the question it answered, and served from the log on every
  replay and in the live tail of every fork, exactly as a fetch is. It resolves
  by key with the source and the question digested into the slot, so a fork
  asking something else reads the world rather than being handed the wrong
  answer; a read that rejects is recorded and rejects again; and a body reaching
  the clock inside one is not reported as ambient, because the answer around it
  is what the log holds. The value goes through JSON, so what comes back on a
  replay is what survived that round trip. `recheck` declines to serve these for
  the same reason it declines to serve a fetch, and `show`, the HTML report and
  `diff` all read them like the network reads they generalize. What this does
  not add is detection: a tool that reads a corpus without saying so is still
  invisible, and still exactly what `recheck` is for.
- **A tool that goes around them is noticed.** `Date.now()`, `new Date()`,
  `Math.random()`, `crypto.randomUUID()` and `fetch` are watched while a tool body runs,
  and a call that reaches one is recorded with what it reached for, as
  `ambient: ["clock"]`. This was the one hole in the determinism guarantee that
  the log could not close — what the tool reached for was not in the log — and
  finding it needed `recheck` to execute the call twice and report `unstable`.
  Now the run that records the call says so, for nothing: `show` prints
  `reads clock`, the report badges it, and `verify` fails its new `ambient`
  check naming the calls whose recorded answers are snapshots rather than
  answers a replay could get again. The wrappers delegate and only observe, and
  come down when the last tool body returns; `new Date(ms)` is arithmetic and is
  not a clock read. Reads are attributed by async context, so a `parallelTools`
  batch marks the call that reached and not the one beside it. A log written
  before this existed carries no marks and is reported clean rather than guessed
  at. Two things stay out of reach and are documented as such: `randomUUID`
  imported from `node:crypto`, which is a binding rather than a global, and a
  read in a subprocess or through a client that never touches
  `globalThis.fetch` — both still `recheck`'s to find. `fetch` is taken from the
  global when the watch goes up rather than at load, so a caller that installed
  its own is not quietly restored to the original when a tool finishes.
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
- **`irreversible: true` on a tool,** and a re-entered run stops rather than
  making that call a second time. A replayed call is free of side effects
  because nothing executes; the live tail of a fork, a resume, or a replay that
  outlives its log is where that stops being true, and a `send_email` there was
  previously sent again with only a caveat in the README to warn you. Now the
  run ends `failed` with `IrreversibleToolError` naming the tool, the effect key
  it would have been recorded under, and the two ways on — fork above the call so
  it replays from the log, or `allowIrreversible` (`--allow-irreversible`) to
  execute it. A fresh run never asks, having nothing to repeat. The whole of a
  step's live tail is checked before any of it runs, so a step that asks for a
  search and a send makes neither call rather than leaving half of one in the
  log. `recheck` holds the same tools back and reports them `held`, since
  re-executing recorded calls is the whole of what it does; naming one with
  `--tool` is not consent, and `--allow-irreversible` is. The mark is not part of
  `ToolSchema`: the model is never shown it, and the tool declarations the log
  records — the ones `stale (tools)` compares — are unchanged by it.
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
- **…and what it moved to.** A digest is one-way, so a single log can say the
  system prompt changed and never what it changed to. Two logs can:
  `explainStale(runId)`, and `retrace stale <run-id>`, rebuild the request
  component by component from this run's log and the parent's and report the
  difference — the two prompts, the tool that went missing, the message an
  override replaced, the question a replayed tool call was asked instead. One
  change is reported once, with every effect it accounts for, so a prompt
  rewritten at step 12 does not print twelve times. It executes nothing and
  exits zero either way, since staleness is a description rather than a failure;
  what it reports instead is which component it could *not* account for and why
  — a parent that is not in this store, or a log written before the digests
  existed. `run.started` now records the tool declarations a run was made with,
  as the model was shown them, without which `stale (tools)` was the one
  staleness nothing could follow up.
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
- **`rebuildRequests(events)`, behind `verify`'s `requests` check.** The one
  check that holds a log to itself rather than to another log — which is what
  makes the run at the top of a lineage checkable at all. Edit what a search
  returned in the original and every other check passes: the fork replayed the
  edited value faithfully, so `parent` holds, `lineage` traces it to the run that
  paid, and the money still adds up. But a log holds both halves of each call —
  the answer, and a digest of what was asked — and what was asked is the
  conversation the earlier answers build. So the run's requests are rebuilt from
  its own effects, the way the loop built them, and compared digest for digest:
  a value edited, reordered or spliced in, an agent spec changed under a run
  after the fact, a tool call holding the answer to an input the response above
  it does not ask for, and a message event pulled apart from the effects it was
  derived from all fail here, naming the call and the component that moved. No
  store, no parent and no network, so it runs on a log attached to a bug report.
  It is not an accusation: a run *served* an edited value built its requests
  around it and verifies clean, correctly, so the edit is caught in the log where
  it was made. A log written before runs recorded their tool declarations, or
  before the digests existed at all, comes back skipped rather than reported as
  edited.
- **`verify`'s `reads` check.** The same question put to the half of a log
  `requests` cannot reach. A `ctx.fetch` and a `ctx.read` are asked for by
  neither the model nor a response, so the walk that rebuilds a conversation
  never arrives at one, and in a run whose tools read the world most of the
  effects were held to nothing at all. They need no rebuilding: the slot a read
  is served from is a digest of what it asked, and what it asked is recorded
  beside the answer, so the key is built back out of the value and compared. A
  recorded request or a read's question edited under its answer fails here and
  nowhere else — and it is the value a fork is served *past* its fork point,
  since the key table outlives the cut, so a doctored response is a doctored
  world for the live tail of every run below it. Every journaled read, the clock
  and ids included, is also held to the tool call that made it, that call's step
  and the slot that call handed out, so an orphan or a missing read is named
  rather than counted. A log whose tools read nothing passes rather than
  skipping: there is nothing in it that could disagree with a slot.
- **An override replaces a read's answer, not the call it answered.** A
  substitution on a `ctx.fetch` used to replace the whole recorded value,
  request included — which left the log holding a response to nothing, crashed
  `show` and `report` on the line that renders it, and severed the value from
  the slot that names it. The request now survives, as a `ctx.read`'s source and
  question already did, and the response keeps its recorded status, status text
  and headers unless the value passed names them: bare text is the body, and an
  object names the fields it replaces, so `{"status":503,"body":""}` is a corpus
  that was down.
- **`verify`'s `conclusion` check.** The last line of a log — what the run
  answered and how it ended — held to the rest of it. Every other check walks
  the effects and stops there, so rewriting `run.finished` used to leave a log
  that verified clean while reporting an answer nobody gave; it is also the line
  `show` prints, `diff` quotes when it says two forks ended differently, and the
  only part of a run most people read. The loop derives its ending rather than
  deciding one, so it can be derived again: the answer is the text of the last
  model response, a refusal carries none at all, and a run that died or ran out
  of steps or money carries the last thing the model actually said. The status
  has a shape too — a `completed` run's final turn asked for no tool calls, a
  `max_steps` run started every step its agent allows, a `budget_exceeded` run
  names a limit its own budget declared, and a `failed` run reports the message
  the call it died on recorded. It needs no store, no parent and no network, and
  a log with no `run.finished` event yet is skipped rather than passed. The
  answer text, the refusal message and the out-of-steps message now come from
  `answerText`, `refusalError` and `exhaustedError` in the loop, so the check
  and the run it checks cannot drift apart.
- **`compareRuns(a, b)`.** Two runs lined up effect by effect, and held to the
  stretch of them they are not free to disagree on. A run's leading replayed
  effects came out of another log at that log's own indices, so two runs that
  replayed the same stretch of the same log must hold the same values across it —
  and checking that needs only the two logs. That is the case `verify` gives up
  on: a fork whose parent is not in the store has a free prefix with nothing to
  check it against, and reports `parent` and `lineage` skipped. Two forks of that
  run check each other instead, and a value doctored in one of them fails.
  Divergence above the shared prefix is a description, not a verdict — it is what
  forking is — so only a contradiction inside the prefix exits non-zero. Only the
  relations a log names directly are claimed: one run forked, resumed or replayed
  from the other, or both from the same run. Runs further apart than that are
  compared and held to nothing, since the logs in between are where the
  connection lives and `lineage` is what walks them. An override excuses the
  position it substituted and not the ones after it, which still came out of the
  log unchanged.
- **Why two runs parted, not only where.** Every pair `compareRuns` lines up
  carries an `asked`, and `retrace diff` prints it as a line of its own: whether
  the two runs were asking the same thing at the position they answered
  differently. Both logs record the digest of what each call was asked, one
  component at a time, so a question that moved names the component — `system` on
  a rewritten prompt, `conversation` under an override — and a question that did
  not moved names nothing, because there is nothing your fork did. That second
  reading is the one no single log could offer: an identical request answered two
  ways is the provider, a tool that reads something the journal does not cover,
  or a corpus that moved between the runs. A `ctx.fetch` carries its digest in
  its key rather than beside it, so a shared slot settles it — unless the body
  was one the journal could not read, and then it says so. A value a run was told
  to serve answers no question and gets no line, and a log written before calls
  carried digests is reported unsettled rather than guessed at.
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
  the report is `ok` when nothing moved and nothing was unstable, and `complete`
  only when everything ran.
- **`unstable`, the finding that separates a moved corpus from a tool that never
  had an answer.** A tool disagreeing with the log reads as the world having
  moved underneath it, and that is only half the cases: the other is a tool
  taking its time, ids or randomness from outside `ctx`, where the journal
  cannot follow it. The two look identical against the log and mean opposite
  things — one is worth re-recording the run for, the other was never replayable
  at all. So a call that disagrees is executed once more against the same
  recorded reads and the two answers compared with each other: agreeing twice is
  `moved`, and failing to is `unstable`. This is the only check anywhere here
  that can find the one determinism caveat the log itself cannot see. A call
  that agreed is executed once and no more, so re-checking a run that holds up
  costs what it always did.
- **`collectBundle(runId, store)` and `importBundle(bundle, store)`.** A run and
  every run it was forked from, as one file, because `lineage` is the check that
  stops working when a run travels: a fork read where its parent has never been
  is a log claiming a free prefix with nothing to check the claim against, and
  the honest report is `skipped`. A bundle is that chain collected where it
  exists — the same JSONL, one event to a line under a header naming what the
  file carries — so the `verify` on the far side is the same check as the one at
  home rather than a check of the bundle. Events are neither recomputed nor
  renumbered in transit. A run the receiving store already holds is left alone if
  the bundle agrees with it event for event, and refused if it does not, since a
  bundle that could overwrite a log would be a way to doctor the history `verify`
  reads. A chain that leaves the exporting store is bundled as far as it goes and
  says where it stopped, rather than passing a partial lineage off as a whole one.
- **A substituted value is marked on the run that was told to substitute it,**
  and not on its descendants. A fork of a counterfactual inherits the value like
  any other recorded value; the `overridden` mark stays in the log where the
  instruction was given, and `lineage` is what finds it from further down.

### The CLI

`retrace ls`, `tree`, `show`, `cost`, `diff`, `replay`, `fork`, `plan`,
`search`, `sweep`, `resume`, `stale`, `report`, `verify`, `recheck`, `export`
and `import`.
`tree [run-id]` draws the family a run belongs to — every run forked, resumed or
replayed from it, and from those — with what each one asked that the run above it
did not: where it cut, what it was told to substitute, and which components moved
under the prefix it replayed. Without a run id it draws every family in the
store. A run whose parent is not in the store roots a family that says which run
is missing above it, and a log too damaged to read is named rather than dropped.
`replay` needs nothing but the log and exits non-zero if the run failed to
reproduce, so it works as a regression check on the loop. `fork --module <path>`
and `resume --module <path>` supply the half a log cannot hold — the tools, the
provider, and any agent overrides.
`plan <run-id> --at <n|effect-key> --module <path>` takes what `fork` takes,
executes none of it, and prints what that fork would replay, save, go stale on
and refuse to run twice; it exits non-zero only on the last of those, so it works
as a pre-flight check in front of a fork.
`search <run-id> --module <path>` forks downward until the answer moves, printing
each trial as it makes it and closing on the fork point it found, what the search
billed and what it did not spend twice; `--until <pattern>` says what to look for
instead of "not the recorded answer", `--at`, `--down-to` and `--max-forks` bound
the walk, and it exits non-zero when nothing matched.
`sweep <run-id> --at <n|effect-key> --module <path>` tries the module's `arms` at
one fork point, printing each arm's answer, the run it made and what its change
moved, and closing on how much of the prefix all of them replayed identically
and what the set of them did not spend again. It exits non-zero when an arm did
not complete or the arms disagree below the fork point.
`--set <effect-key>=<value>`, on `fork` and `replay`, is the counterfactual.
`stale <run-id>` reads the run against the one it replayed from and prints both
sides of everything that moved under its free prefix.
`diff <run-a> <run-b>` collapses the effects the two share, names the ones they
don't, and exits non-zero only when they disagree somewhere neither of them ran.
`report` writes the run as one self-contained HTML page: no JavaScript, no
network, readable in a light or a dark browser. `verify` prints one line per
check and exits non-zero on a failure, so it can gate a pipeline. `recheck
--module <path>` does the same for the tools, printing both answers where one
has moved and today's two answers where one is `unstable`; `--tool <name>` is
repeatable and keeps it away from the tools that should not run twice, as does
marking those tools `irreversible`.
`--allow-irreversible`, on `fork`, `resume`, `replay` and `recheck`, is how you
say a tool that declares it cannot be repeated should be executed anyway.
`export <run-id> -o <path>` writes the run and its whole lineage as one file —
`-` for stdout — and `import <path>` reads one into the store `--dir` names, so
`verify` runs complete on a machine that has only ever seen the fork.

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

488 tests that run with no network and no API key, plus two `[live]` integration
tests that skip themselves when `ANTHROPIC_API_KEY` is unset. GitHub Actions
runs the typecheck, the suite, the build, the demo and a packing dry run on Node
22 and 24 on every push and pull request. The manifest is under test too:
`test/package.test.ts` fails if an entry point names a file the build will not
emit, if `src` imports something an install would not resolve, or if the
changelog stops short of the version `package.json` would publish.
