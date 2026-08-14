# Retrace

**Agent runs are event logs you can rewind.** Record a run once, then replay it exactly, or fork it from any step — the prefix comes out of the log for free and execution goes live from the point you changed.

The usual way to debug an agent is to run it again and hope. A twelve-step run that went wrong at step nine costs you nine steps of tokens and nine steps of latency every time you want to try a different prompt. Retrace makes those nine steps free.

```
$ npx retrace show demo-forked

demo-forked  completed
analyst · claude-opus-5 · via anthropic
forked from demo-original at step 3

step 0
  replayed  model  step:0  stale (system)
  replayed  tool   step:0#0:search
            → 3 results for "market size"
step 1
  replayed  model  step:1  stale (system)
  replayed  tool   step:1#0:search
            → 3 results for "competitors"
step 2
  replayed  model  step:2  stale (system)
  replayed  tool   step:2#0:search
            → 3 results for "pricing"
step 3
  live      model  step:3  2140ms
  says      Large market. Crowded. Per-seat pricing.

finished completed
  4 steps · 3 tool calls · 2.1s · list $0.9200 · billed $0.2300  saved $0.6900
```

## How it works

Every nondeterministic thing an agent does — model calls, tool calls — passes through one function:

```ts
const outcome = await journal.effect("model", `step:${step}`, () => provider.complete(request));
```

With an empty journal, the effect executes and gets appended to the log. With a preloaded journal, it comes back out of the log without executing. **Replay is not a separate code path**; it is the same loop with a non-empty journal. That is why a replayed run can't drift from the recorded one — there is no second implementation to drift from.

A fork preloads the journal with the parent's effects up to `atStep` and leaves the rest empty. Steps below the fork point replay; the moment the log runs out, execution goes live. If the fork asks for an effect the log doesn't have in that slot — a truncated log, a hand-edited result — it fails with a `DivergenceError` naming the exact effect, rather than silently serving the wrong value.

## What a replayed step is still answering

Notice the word `stale` in that timeline. Every model call goes into the log with
a digest of the request that produced it — and with that same digest taken one
component at a time: the model, the system prompt, the tools, the conversation
so far, the token and thinking settings. When a step is served from the log, the
digest of the request the loop *just built* is compared against it, component by
component.

That is the one thing a log cannot otherwise tell you. The demo above forked at
step 3 with a rewritten system prompt, so steps 0–2 came back for free and are
still answers to the old instruction. Both facts are true, and only one of them
used to be visible.

```bash
retrace fork demo-original --at 3 --module ./agent-module.ts
# 3 replayed model calls answer a request this run no longer builds — system changed
```

`system`, and nothing else, is the fork doing what you asked. The list is the
actionable half: a fork that rewrites the prompt and reports `system, tools` is
telling you the module you passed does not declare the tools the run was
recorded with — a misconfiguration that used to look exactly like a fork working
correctly. The names are `model`, `system`, `tools`, `conversation` and
`settings`, always in that order, and in code the list is `staleFacets(events)`.

It is a label, not an error. Replaying the steps below the one you changed is
what forking *is*; the point is that you can now see how much of your prefix is
answering the old question, in `show`, in the HTML report, and in the log
itself. In code it is `staleEffects(events)`.

Where it *is* a warning is a plain replay, which should reproduce a run exactly:

```bash
retrace replay demo-original --module ./agent-module.ts
# reproduced 7 effects, identical · $0.9200 not spent
```

Nothing stale there means the loop rebuilt the same requests, not merely that
the same values came back out — which is a stronger claim than matching outputs,
and the one nothing checked before. Run `replay` without `--module` and every
model call comes back stale, correctly, and says why:

```bash
retrace replay demo-original
# 4 replayed model calls answer a request this run no longer builds — tools changed
```

With no tools declared, the requests the loop assembles are not the ones the log
was recorded with. It still reproduces. It just tells you what it reproduced
from, and now which part of the question it is no longer asking.

Tool calls carry a digest too, of the input they were called with. Usually there
is nothing in it to see: a tool's input comes out of a model response, and below
a fork point that response comes out of the log along with everything else, so
rewriting the prompt moves `system` on the model calls and leaves every tool
call in the prefix answering exactly what it was asked.

Where it earns its keep is the one thing that *can* move a tool's input without
moving its slot — [replacing the model response above
it](#what-if-it-had-said-something-else), or a log edited by hand:

```bash
retrace fork demo-original --at 3 --set 'step:0=…asking for a different query…'
# 1 replayed tool call was given the answer to a different call — input changed
```

The key `step:0#0:search` matched, so the log answered; the query it answered
was the parent's, not this run's. That used to be silent, and silence is the
worst outcome for a counterfactual — you would read the result as the tool's
answer to a question it was never put. The facet is `input`, and the tool's own
name is deliberately not in the digest: a call to a *different* tool lands in a
different slot, which is a `DivergenceError` rather than a staleness.

## Install

Nothing is on npm yet, so install it from the repository — the `prepare` script
builds it on the way in:

```bash
npm install github:Amritha902/retrace
```

Requires Node 22.6+, and an `ANTHROPIC_API_KEY` for the parts that reach a model.

## Use

```ts
import { AnthropicProvider, defineAgent, objectSchema, run, tool } from "retrace";

const search = tool({
  name: "search",
  description:
    "Search the corpus. Call this whenever the answer depends on a fact you were not given.",
  inputSchema: objectSchema({ query: { type: "string" } }),
  run: async ({ query }) => (await db.search(query)).join("\n"),
});

const agent = defineAgent({
  name: "analyst",
  model: "claude-opus-5",
  system: "You are a research analyst.",
  maxSteps: 8,
});

const result = await run("Analyse the note-taking app market.", {
  agent,
  provider: new AnthropicProvider(),
  tools: [search],
  budget: { usd: 5, wallClockMs: 120_000 },
});

console.log(result.output, result.runId);
```

Then rewrite just the last step:

```ts
import { fork } from "retrace";

const better = await fork(result.runId, {
  provider: new AnthropicProvider(),
  tools: [search],
  atStep: 3, // steps 0–2 replay from the log; step 3 runs live
  agent: { system: "You are a research analyst. Answer in at most ten words." },
});

console.log(better.totals.savedUsd); // what the replayed prefix saved
```

## Forking inside a step

A step is the coarsest place to re-enter a run, and sometimes it is too coarse.
A step that asked for four searches and went wrong on the third has a fork point
in the middle of it: `atEffect` cuts there instead.

```ts
const again = await fork(result.runId, {
  provider,
  tools: [search],
  atEffect: "step:2#2:search", // everything recorded before this replays; this runs live
});
```

```bash
retrace fork demo-original --at 'step:2#2:search' --module ./agent-module.ts
# researcher · claude-opus-5 · everything recorded before step:2#2:search replays, and it runs live
```

The difference from `--at 3` is what happens to the model turn that asked for
the calls. Forking at the step throws it away and asks the model again — which
gets you a different question, and the answer to a different question is not the
counterfactual you wanted. Forking at the effect keeps the turn, replays the
searches before it, and executes from the one you named. The two earlier results
come out of the log; the third comes from the corpus as it is today.

That is the command [`recheck`](#checking-a-log-against-the-world) leaves you
holding. It tells you which recorded call the world has moved under; `--at
<that key>` is how you re-run the run from it without paying for the steps
below it, or losing the turn that asked.

A fork point is a model or tool call — `step:2` is the model turn of step 2, and
forking there is the same run as forking at step 2, by the same boundary under
two names. Clock, id and random reads are not fork points: they resolve by key
and are served wherever the run reaches them, so cutting the sequence at one is
refused rather than quietly meaning something else. The log records both halves
of where it went live, `atStep` and `atEffect`, so `show`, `report` and `verify`
all hold the fork to the finer of the two.

Or verify a run reproduces exactly:

```ts
import { replay } from "retrace";

const again = await replay(result.runId, { provider, tools: [search] });
// Reaches neither the model nor the tools. Same output, $0.
```

## Picking a run back up

A run that died at step nine — the process was killed, the machine went away,
the model call threw — left nine steps of work on disk. `resume` preloads the
whole log and goes live at the effect it ends on:

```ts
import { resume } from "retrace";

const finished = await resume(crashedRunId, { provider, tools: [search] });
```

Nothing about it is a special code path: it is a fork whose fork point is
wherever the log happens to stop. The steps that completed replay, the tool call
that was in flight when the process died executes, and the run carries on.

```bash
retrace resume run_20260813T0904_5f21ad --module ./agent-module.ts
# picked up at step 9: 21 effects replayed, 4 ran live · saved $1.87
```

Because the log is appended synchronously one event at a time, the crash can
land in the middle of a write. A final half-written line is dropped on read —
every line before it was complete before it was started — so the prefix is still
a truthful record of what happened. A broken line anywhere *but* the end is real
corruption and still an error.

A run that died because the *model* threw ends its log with the throw. `resume`
drops that last effect and makes the call again — see [the run that
broke](#the-run-that-broke) — which is the one place anything here declines to
serve a recorded value, and it is the whole reason you would resume such a run.

Two things worth knowing before you run it. A tool that executed but whose
result never reached the log will execute again, because from the log's point of
view it never ran; the [determinism caveats](#determinism-honestly) about
irreversible tools apply with full force here. And a run that stopped because it
hit a limit will stop there again — the replayed steps spend the budget exactly
as the original did — so raise `maxSteps` or the budget in the same call:

```ts
await resume(runId, { provider, tools: [search], budget: { usd: 20 } });
```

A run that ended with an answer is refused rather than re-run: the prefix would
replay to the same answer, and the new log would look like progress that never
happened. `replay` is the command for that.

## The run that broke

The run you most want to rewind is the one that died, and a throw is an outcome
like any other — so it goes in the log where the value would have gone:

```
$ retrace show died

died  failed
analyst · claude-opus-5 · via anthropic

step 0
  live      model  step:0  1980ms
  live      tool   step:0#0:search  412ms
            → 3 results for "market size"
step 1
  live      model  step:1  240ms
        threw  the model is overloaded, try again

finished failed
  the model is overloaded, try again
```

That log replays into the same failure, with the same message, without calling
anything:

```bash
retrace replay died
# reproduced 3 effects, identical · $0.4600 not spent
```

Before this the failure was the one thing the log did not hold, so a replay ran
off the end of it and made the call live — and a call that succeeded this time
turned a failed run into a completed one that looked like a reproduction. Now
`replay`, `fork` and `report` all treat a throw as an outcome, and the run that
broke is as rewindable as the run that worked.

`resume` is the exception, and deliberately: retrying the call the run died on
is the reason you came back to it. The steps below it replay, the failure is
dropped, and that call is made again.

```bash
retrace resume died --module ./agent-module.ts
# picked up at step 1: 2 effects replayed, 3 ran live · saved $0.4600
```

The other way to ask is to not re-run it at all. An
[override](#what-if-it-had-said-something-else) on the effect that threw hands
it the answer it never gave, and the run carries on from there as if the model
had replied:

```bash
retrace fork died --at 2 --set 'step:1={"model":"claude-opus-5","content":[…]}' --module ./agent-module.ts
```

The log then holds a value and no failure, marked `set` — an effect cannot both
return that and have thrown.

## What if it had said something else

A fork changes the agent. `overrides` changes the world it ran in: hand any
recorded effect a different value and the run continues from there as if that
had been the value all along.

```ts
const empty = await fork(result.runId, {
  provider,
  tools: [search],
  atStep: 3,
  overrides: { "step:2#0:search": "no results" }, // what if the corpus had nothing?
});
```

```bash
retrace fork demo-original --at 3 --set 'step:0#0:search=no results' --module ./agent-module.ts
```

The key is the effect key, exactly as `show` and `report` print it. A tool result
given as bare text replaces the text and leaves the outcome a success; pass
`{ content, isError }` to replace the whole thing, including making a tool fail
that didn't. Model responses, timestamps, uuids and random draws take the value
you give them as-is. The substituted value goes in the fork's log marked
`overridden`, so the log holds what the run actually saw *and* says it was not
what the parent recorded.

The mark stays on the run that was given the instruction. Fork *that* run and the
value is inherited like any other recorded value — a descendant claiming a
substitution nobody asked it for would be saying something false about itself —
so the substitution stays on record where it was made, and
[`verify`'s lineage check](#checking-a-log-against-itself) is what finds it from
further down.

Two things this refuses to do quietly. An override naming an effect the log
doesn't hold is an error, not a no-op. So is one at a step the fork runs live —
there is no log read there to intercept, so the tool would simply execute and
the answer you got back would not be the answer to the question you asked.

The interesting part is what happens *below* the override. Replace step 0's
search and steps 1 and 2 still replay — they have to, that is what makes the
prefix free — but they were recorded against a conversation that no longer
exists, so they come back `stale`, from exactly the same request digest that
marks a rewritten prompt:

```
$ retrace fork demo-original --at 3 --set 'step:0#0:search=no results' --module ./agent-module.ts
...
1 effect served a value you set instead of the recorded one: step:0#0:search
2 replayed model calls answer a request this run no longer builds — conversation changed
```

`conversation`, where a rewritten prompt would have said `system`: the agent is
the one you recorded, and what moved underneath it is what it was told. That is
the whole difference between changing the agent and changing the world, and it
now comes out of the log rather than out of remembering which command you ran.

Replacing a *model response* is the sharper version of the same move, and the
one place a replayed tool call can stop being an answer. Hand step 0 a response
that asks for a different query and step 0's tool call still lands in
`step:0#0:search`, still comes out of the log, and is now the parent's answer to
the parent's question. It is marked `stale (input)` for it — see [what a
replayed step is still answering](#what-a-replayed-step-is-still-answering).

That second line is the honest reading of the first. The counterfactual is real
for step 3, which ran live against the new world; steps 1 and 2 are the old
world's answers, kept for their price. Fork lower to make more of the run
respond to the change, and pay for more of it.

## Time, ids and randomness

A tool's second argument is the journal. Anything taken from it is recorded and
comes back unchanged later:

```ts
run: async ({ amount }, ctx) => {
  const id = await ctx.uuid();   // step:2#0:charge/uuid:0
  const at = await ctx.now();    // step:2#0:charge/clock:0
  return `${id} charged ${amount} at ${at}`;
},
```

These resolve differently from model and tool calls, on purpose. A model call is
part of the *shape* of a run, so it is served by position and a mismatch is a
`DivergenceError`. A timestamp is not part of the shape — nothing downstream
cares what it is, only that it doesn't move. So clock, uuid and random reads are
keyed by the call they happened in, and **the key table outlives the fork point**:

```
retrace fork demo-original --at 3 --module ./agent-module.ts
```

Steps 0–2 replay whole. Step 4 runs live — and if its tool calls `ctx.now()`, it
gets the timestamp the parent recorded at that same slot, not today's clock. The
fork differs from its parent in the thing you changed and nothing else, which is
what makes `retrace diff` worth reading. A slot the parent never filled — a tool
call the fork invented — gets a fresh value.

`Date.now()` and `Math.random()` called directly are still just the clock and the
RNG. The journal only covers what you take from it.

## Streaming

Pass `onStream` and the loop takes the provider's streaming path, handing you
each fragment as the model produces it:

```ts
await run("Analyse the note-taking app market.", {
  agent,
  provider: new AnthropicProvider(),
  tools: [search],
  onStream: ({ delta }) => {
    if (delta.kind === "text") process.stdout.write(delta.text);
  },
});
```

What lands in the journal is the assembled message, never the token stream. The
same run recorded with streaming on and with it off leaves a byte-identical log,
so streaming changes what you can watch and nothing about what you can replay.

Which also means a replayed step has fragments to give you. They are cut from the
recorded message rather than read off the wire — one per content block, flagged
`replayed: true` — so a fork renders the same way on both sides of its fork
point: a calm replayed prefix, then the step that actually types. A provider with
no `stream` method needs no special handling either; its turn simply arrives in
one piece.

## Tools at once

A step where the model asks for four searches runs them one after another, which
costs four round trips of latency to get one step's worth of work done. Set
`parallelTools` and they overlap:

```ts
const agent = defineAgent({
  name: "analyst",
  model: "claude-opus-5",
  parallelTools: true,
});
```

The log does not change. Tool bodies execute concurrently, but their results are
journaled afterwards in the order the model asked for them, so the effects land
in the same slots with the same keys — `step:0#0:search` before `step:0#1:search`
— whichever one finished first. A run recorded with `parallelTools` on and one
recorded with it off produce the same event log, which is what lets a parallel
run replay, fork, and diff like any other.

Time and ids survive the same way, because a `ctx.now()` read resolves by key
rather than by whoever reached it first: `step:0#1:search/clock:0` is the same
slot no matter when in the batch it was read.

It is off by default, and the reason is in the name of the guarantee. The *log*
is deterministic; the *side effects* aren't. Four reads overlapping is fine; two
tools writing to the same row is a race you have introduced, and the journal
will faithfully record whichever result it produced.

Two other things change with it on. Replayed calls are never parallelized —
there is nothing to overlap when nothing executes — so in a fork only the live
tail of a step runs at once. And the batch is charged against
`budget.toolCalls` before any of it starts, so a step that cannot afford all its
calls makes none of them, rather than leaving half a step in the log.

## Budgets

Limits are enforced by the scheduler, so running out is a terminal state with a log entry — not an exception from somewhere inside a tool call.

```ts
budget: {
  usd: 5,             // priced from the model's rate card
  steps: 20,
  toolCalls: 50,
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  wallClockMs: 300_000,
}
```

The run stops with `status: "budget_exceeded"` and its totals intact.

Every charge is tracked twice: `costUsd` is what the tokens are worth at list price, `billedUsd` is what was actually spent. A replayed step has a real cost and a zero bill, and `savedUsd` is the gap.

## CLI

```bash
retrace ls                    # every run, with cost and what replay saved
retrace show <run-id>         # the timeline, marking each effect live or replayed
retrace cost <run-id>         # per-step spend
retrace diff <run-a> <run-b>  # where two runs stopped agreeing
retrace replay <run-id>       # re-run it from the log and check it reproduces
retrace fork <run-id> --at N  # replay the steps below N, then run live
retrace fork … --at <key>     # …or re-enter mid-step, at one recorded call
retrace fork … --set k=v      # …serving v in place of the effect recorded at k
retrace resume <run-id>       # carry on a run that stopped early, from its log
retrace report <run-id>       # write the run as one self-contained HTML page
retrace verify <run-id>       # hold the log to its own claims, and to its parent
retrace recheck <run-id>      # …and ask the tools whether its answers still hold
retrace export <run-id>       # the run and everything it was forked from, as one file
retrace import <path>         # …read back into a store, so verify runs whole there
```

`diff` is the one to reach for after a fork — it shows exactly which effect the two runs stopped sharing.

### Re-running from the command line

`replay` needs nothing but the log. It re-runs the recorded loop, reaches neither the model nor your tools, and then compares what came out against what went in:

```
$ retrace replay demo-original
...
new run replay_20260812163416_838c0f5e
reproduced 7 effects, identical · $0.9200 not spent
4 replayed model calls answer a request this run no longer builds
```

It exits non-zero if the replay diverged, ended differently, or ran past the end
of the log — so it works as a regression check on the loop itself. The last line
is a note rather than a failure, and here it is the honest description of a
replay given no `--module`: the loop rebuilt its requests with no tools
declared. Pass the module and it goes away. See [what a replayed step is still
answering](#what-a-replayed-step-is-still-answering).

`fork` has to execute the steps above the fork point, and a log cannot hold a running tool. `--module` supplies that half; everything else — input, model, budget — comes from the recorded run:

```ts
// agent-module.ts
export const tools = [search];
export const provider = new AnthropicProvider();
export const agent = { system: "You are a research analyst. Answer in ten words." };
```

```bash
retrace fork demo-original --at 3 --module ./agent-module.ts
retrace fork demo-original --at 'step:2#2:search' --module ./agent-module.ts
```

`--at` takes a step number, or an effect key as `show` prints it — see [forking
inside a step](#forking-inside-a-step).

Named exports and a `default` object both work. The file is imported for its exports, so it must not run anything at import time — see `examples/research.ts`, which guards its runner behind an entry-point check for exactly that reason. `--module` is optional for `replay`, and only matters there if the log stops short of the run it recorded.

`resume` takes the same module and needs it for the same reason: it is going to
execute. Everything else — where to pick up, what the agent is, what it was
asked — comes out of the log.

```
$ retrace resume killed_20260813T0904 --module ./agent-module.ts
killed_20260813T0904 → resume after 21 recorded effects
analyst · claude-opus-5 · stopped running; the log replays, then it runs live
...
picked up at step 9: 21 effects replayed, 4 ran live · saved $1.87
```

If the log turns out to hold the entire run — the process died after the final
answer but before recording that it had — it says so and spends nothing. If the
run stopped at a limit and nothing was raised, it says that too rather than
writing a duplicate log that looks like progress.

Add `--on-divergence live` to any of these commands to treat a log that disagrees with the loop as the fork point rather than an error.

`--set <effect-key>=<value>` is the counterfactual, and takes both commands. It
is repeatable, and the value is read as JSON where it parses as JSON and as
plain text where it doesn't — so `--set 'step:2#0:search=no results'` sets the
text a tool returned and `--set 'step:1#0:charge/clock:0=1700000000000'` sets a
timestamp it read. See [what if it had said something
else](#what-if-it-had-said-something-else).

### The run as a page

`report` turns a log into one HTML file — every effect, what each tool was called
with and what it returned, what a tool read from the clock, and where the money
went:

```bash
retrace report demo-forked -o trace.html   # or -o - to pipe it somewhere
```

There is no JavaScript in it, nothing is fetched from the network, and it reads
in a light or a dark browser. Replayed effects are green and live ones are rust,
which in a fork makes the shape of the thing obvious at a glance: a long calm
prefix, then the step you changed. Anything in that prefix still answering the
question you replaced carries a `stale system` badge naming what moved, and any
value that came out of the log changed carries a `set` one. The page is built
from the log and nothing
else, so it renders the same on any machine, and rendering the same log twice
gives you the same bytes.

### Checking a log against itself

A fork bills nothing for its prefix because the prefix came out of the parent.
Read on its own, though, a fork's log only shows a run that did a great deal of
work for free — nothing in it says the work is the same work.

```bash
retrace verify demo-forked
```

```
demo-forked  completed
forked from demo-original at step 3

  ok   shape        24 events, 7 effects, indices dense and in order
  ok   accounting   $0.9200 at list price, $0.2300 billed, $0.6900 saved — the charges add up
  ok   free replay  6 of 7 effects came out of the log, and none of them was billed
  ok   markings     3 stale (system), 0 substituted, all of them served from the log
  ok   parent       6 replayed effects are demo-original's, value for value
  ok   lineage      6 free effects trace back to demo-original, which executed and paid for them

verified: this log holds up against everything it claims
```

`parent` is the one worth having. Every effect this run served from the log is
looked up in the run it says it came from and compared value for value, so an
edited prefix, a spliced log or a fork pointed at the wrong parent stops being
something you take on trust. The rest hold the log to its own arithmetic: the
charges add up to the totals it reports, nothing served from the log was billed
or claims to have taken time, and nothing that executed is marked `stale` or
`overridden`.

`lineage` asks the question one hop up cannot answer: *who actually paid*. Fork a
fork of a fork — the ordinary shape of this, since the whole point is to keep
re-entering the same run — and every one of them claims the same prefix as free,
each on the strength of a log that only ever points one hop back. So the check
follows each free effect up the chain until it reaches the run that executed it,
comparing values at every hop on the way:

```
  ok   lineage      4 free effects trace back 3 runs to demo-original, which executed and paid for them
```

Three things live here and nowhere else. A value doctored in the *middle* of a
lineage passes `parent` at both ends — the child agrees with the log it was
forked from — and disagrees with the run that produced it. A log with a free
prefix and no parent to have taken it from is a saving nothing accounts for, and
without an origin there is no parent to check. And a fork that inherits a value
an ancestor [made up](#what-if-it-had-said-something-else) traces back to that
substitution rather than to an execution, and is counted apart from the rest:

```
  ok   lineage      3 free effects trace back 2 runs to demo-original, which executed and
                    paid for them; 1 more carries a value substituted somewhere in this
                    lineage rather than executed anywhere in it
```

It reads logs and executes nothing, so it says the same thing about a run
recorded on another machine a year ago, and it exits non-zero on a failed check.
A check it cannot run — a lineage that leaves this store, a killed run with no
totals yet — comes back skipped rather than passed, traced as far as it goes, and
the last line says how much of the verification that leaves undone. In code it is
`verifyRun(runId)`.

### Taking a lineage with you

`lineage` is the check that stops working when a run travels. A fork's log names
the run it came from and nothing else, so a fork read on a machine that has never
seen that run is a log claiming a free prefix with nothing to check the claim
against: `parent` traces the one hop it can see, and `lineage` comes back
skipped. That is the honest answer, and it is the answer you get for a run
attached to a bug report, mailed to a colleague, or committed next to the code it
was recorded against.

`export` writes the run and every run above it as one file:

```bash
retrace export demo-forked -o lineage.jsonl
```

```
demo-forked → lineage.jsonl
2 runs, 48 events, 13KB
1 run of lineage, back to a run forked from nothing — verify runs complete wherever this lands
```

```bash
retrace import lineage.jsonl
```

```
lineage.jsonl → .retrace/runs
2 runs: added demo-original; already here demo-forked
retrace verify demo-forked now has the runs it needs
```

It is the same JSONL the runs themselves are, one event to a line under a header
naming what the file carries, so a bundle of a long lineage streams and diffs the
way the logs inside it do. Nothing is recomputed on the way out or the way in —
the events land in the receiving store exactly as they were recorded, which is
what makes the `verify` on the far side the same check as the one at home rather
than a check of the bundle.

Two things it refuses. A run the receiving store already holds is left alone if
the bundle agrees with it, event for event, and refused if it does not: a bundle
that could overwrite a log would be a way to doctor the very history `verify`
reads, arriving through the front door. And a chain that leaves the *exporting*
store is bundled as far as it goes and says so, rather than passing a partial
lineage off as a whole one:

```
the chain stops short: "demo-original" is not in this store — a verify of this
bundle traces its lineage that far and reports the rest skipped, exactly as one
here would
```

In code it is `collectBundle(runId, store)`, `serializeBundle`, `parseBundle` and
`importBundle(bundle, store)`.

### Checking a log against the world

`verify` executes nothing, which is what makes it portable and also what bounds
it. It can prove a fork's free prefix is the prefix its parent recorded. It
cannot tell you that prefix is still *true* — a search recorded last month is
replayed today as though the corpus had not moved underneath it, and no amount
of reading the log will show that, because the thing that changed is not in the
log.

`recheck` is the half that executes. It takes each tool call the log records,
puts the question the model asked at the time back to the tool as it is today,
and compares the answers:

```bash
retrace recheck demo-forked --module ./agent-module.ts
```

```
demo-forked  completed
analyst · claude-opus-5 · 3 recorded tool calls

  same    step:0#0:search  {"query":"market size"}
  same    step:1#0:search  {"query":"competitors"}
  moved   step:2#0:search  {"query":"pricing"}
                           was  3 results for "pricing"
                           now  5 results for "pricing"

moved: 1 of 3 re-executed tool calls no longer returns what the log holds — a
fork off this run replays an answer the world has since changed
```

That last line is the whole point of the command. Everything else here works to
make a replayed prefix free; this is the one thing that says whether a free
prefix is still worth having. What to do about it is
`retrace fork demo-forked --at 'step:2#0:search'` — [re-enter the run at the
call that moved](#forking-inside-a-step), keeping everything above it.

`moved` reads as *the world changed under a stable tool*, and that is only one
of the two things that make a tool disagree with the log. The other is a tool
with no settled answer at all — one that reads the clock, an id or a counter
from outside `ctx`, where [the journal cannot follow
it](#time-ids-and-randomness). Both look identical against the log, and they
mean opposite things: a moved corpus is worth re-recording the run for, and an
unstable tool is a run that was never replayable in the first place. So a call
that disagrees is asked *once more*, and the two answers are compared with each
other rather than with the log:

```
  unstable  step:0#0:lookup  {"term":"alpha"}
                             was  definition of alpha
                             now  definition of alpha (read 1)
                             now  definition of alpha (read 2)

unstable: 1 of 3 re-executed tool calls did not give the same answer twice — it
reads something the journal does not cover, so what the log holds is a snapshot
rather than an answer a fork could replay
```

Two `now` lines, because both of them are what it says now. This is the one
check anywhere here that can find the hazard the [determinism
caveats](#determinism-honestly) have always had to state and never had to
prove — a tool reaching past `ctx` for its time or its ids. The recorded reads
resolve by key, so a tool taking those from `ctx` gets the same ones both times
and can only differ by going somewhere the journal is not.

The second execution only happens where there is already a finding to explain: a
call that agreed with the log is asked once and no more, so re-checking a run
that holds up costs exactly what it did before. A call that disagreed runs twice
— which matters for the same reason the rest of this command does, and `--tool`
is still the answer.

The model is never called — the questions are already in the log, and asking it
again would just be a second run. And what gets asked is exactly what was asked:
a tool's own effect holds only a digest of its input, so the input itself is read
back off the model response that requested the call, keyed the way the loop keyed
it. Each call is also handed the clock, ids and randomness the run recorded at
the same slots, so a tool that stamps `now()` into its answer is compared on what
it said rather than on when it was asked.

Three outcomes are not comparisons, and are counted apart rather than folded into
a pass. A call naming a tool the module does not export is `no tool`. A call you
kept `--tool` away from is `skipped`. A value an
[override](#what-if-it-had-said-something-else) substituted is `set` — no tool
ever produced it, so a tool disagreeing with it is the tool being right. The
report is `ok` when nothing moved and nothing was unstable, and `complete` only
when everything actually ran, and the closing line reports the difference rather
than calling a run checked that wasn't:

```
still true as far as it goes: 2 of 3 recorded tool calls re-executed and agreed;
1 names a tool the module does not export
```

**It executes your tools, for real.** That is the point, and it is the same
hazard as forking past a `send_email`, arriving at the moment you are auditing
rather than running. `--tool <name>` is repeatable and limits execution to the
tools you name, which is how you re-check the reads and leave the writes alone.
It exits non-zero when something moved, so it can gate a pipeline. In code it is
`recheckRun(runId, { tools })`.

## Storage

Runs are JSONL under `.retrace/runs/<run-id>.jsonl`, one event per line, appended synchronously. If the process dies mid-run the log is still a truthful prefix — a torn final line is dropped on read, and everything before it stands — and a truthful prefix is enough to [pick the run back up](#picking-a-run-back-up). `MemoryStore` is the same interface with nothing on disk.

The log holds normalized, provider-agnostic content, plus the provider's own blocks verbatim (thinking blocks are signed and have to be echoed back byte-for-byte). A run recorded today still replays after the SDK's types change underneath it.

## Determinism, honestly

Retrace guarantees the *agent loop* is deterministic given its journal. It does not make your tools deterministic. Specifically:

- **Tool side effects are real.** A replayed tool call returns the recorded result without executing, which is the point — but a fork that goes live past a `send_email` tool will send the email again. Gate irreversible tools yourself.
- **A resume re-runs the tool call that was in flight when the run died.** Its result never reached the log, so as far as the log is concerned it never ran — and the log is all `resume` has. A tool that had already done its work and was killed before returning does that work twice. This is the same hazard as the bullet above, arriving at the one moment you are least likely to be thinking about it.
- **Tools run sequentially by default**, in the order the model requested them. `parallelTools` overlaps them and still records deterministically — results are journaled in request order, and time and ids resolve by key — but the side-effect ordering isn't, which is why it is opt-in rather than on.
- **Clock and randomness are journaled only if you take them from the tool
  context.** `ctx.now()`, `ctx.uuid()` and `ctx.random()` are recorded and
  stable; a tool that calls `Date.now()` directly still reads the real clock and
  may branch differently when it goes live. This is the one hole in the
  guarantee that nothing in the log can close, because what the tool reached for
  is not in the log. It is, however, findable:
  [`recheck`](#checking-a-log-against-the-world) executes a disagreeing call a
  second time against the same recorded reads, and a tool that cannot agree with
  itself is reported `unstable` rather than `moved`. That does not make such a
  tool replayable — nothing can, short of taking the value from `ctx` — but it
  is the difference between a caveat you have to remember and one the runtime
  will point at.
- **A fork point inside a step keeps the model turn that asked.** `atEffect`
  cuts the log between two calls rather than between two steps, so the call it
  names executes with the input the *recorded* turn asked for. That is the
  point — re-asking the model would get you a different question — but it does
  mean the live call at the fork point is answering the parent's question, and
  the fork's own log is the only place that says so. Only model and tool calls
  can be fork points; a clock, id or random read resolves by key and is served
  wherever the run reaches it, so naming one is refused rather than silently
  meaning something else.
- **Deterministic values are matched by slot, not by meaning.** A fork that reaches `step:4#0:search` gets whatever the parent recorded at `step:4#0:search`, even if the fork's step 4 is asking a different question. For a timestamp that is the point; if your tool derives something load-bearing from `ctx.random()`, know that it is keyed by position in the run.
- **A model call that throws is recorded, and replays as a throw.** The failure
  goes in the log where the value would have gone, so a run that died on a 529
  replays into the same error without calling anything — which it did not do
  before, and the live call it used to make could succeed and turn a failed run
  into a completed one. What survives is the message and the error's name, not
  its class: a log is JSON, and a replay raises `ReplayedFailure` carrying both.
  `resume` is the deliberate exception — it drops the trailing failure and
  retries the call, because that is what resuming a broken run is for.
- **Streaming is a view of a model call, not an effect.** Fragments never reach the log; the message they assemble into does. A replayed step reconstructs its fragments from the log, one per content block, so you get the same text back but not the same cadence.
- **Changing `input`, the prompt or the tools on a fork with `atStep > 0` does nothing for the replayed steps** — those model calls come from the log, which was produced with the old ones. That is the point of forking, and since it is easy to forget, the log now marks each such step `stale`: replayed, and recorded against a request this run no longer builds. Fork at 0 to change what the replayed steps saw.
- **The digest behind `stale` covers what was asked, not the world.** For a model call that is the request: model, system prompt, tools, conversation, token and thinking settings — all of it, and each of them separately, so the log names which one moved rather than only that one did. For a tool call it is the input the model supplied, under the facet `input`. A tool that returns something different today because a database moved underneath it is not something either digest can see. Nor is the list a diff: it says the system prompt changed, not what it changed to, because a digest is all the log keeps.
- **A tool call's digest is a check on the question, not on the tool.** It catches the case where a replayed tool call is handed the parent's answer to a call this run does not make — which happens when a model response above it was [replaced](#what-if-it-had-said-something-else), and essentially never otherwise. It says nothing about whether the recorded result is still what the tool would return — that question needs the tool rather than the log, and [`recheck`](#checking-a-log-against-the-world) is what asks it. Tool calls recorded before this existed carry no digest and are reported clean rather than guessed at, exactly as older model calls are.
- **A log recorded before the per-component digests still compares, and still won't guess.** Staleness is decided by the whole-request digest, which has not changed, so an older log detects it exactly as before; it simply has no components to compare, and reports `stale` with nothing named rather than naming something it did not check.
- **`verify` checks the log against the log.** It proves that a fork's free
  prefix is the prefix its parent recorded, that following the chain up leads to
  a run that executed and was billed for it, and that the money adds up to the
  savings claimed. It cannot tell you the recorded values were the right
  answers, or that a tool asked the same question today would still say the same
  thing — nothing that reads only a log can. `recheck` executes the tools and
  answers the second of those; the first is not a question anything here settles.
  And `verify` can only follow a lineage as far as the logs it has: a chain that
  leaves the store is traced to that point and reported skipped, not passed —
  which is a fact about the store rather than about the run, and
  [`export`](#taking-a-lineage-with-you) is how you hand it the rest.
- **`recheck` executes your tools, on purpose.** It is the one command here that
  reaches the world by design, so a recorded `send_email` is sent again unless
  `--tool` keeps it out of the run — and a call that disagrees with the log is
  executed *twice*, since asking again is what separates a moved corpus from a
  tool with no settled answer. A call that agreed is asked once. It hands each
  call the clock, ids and randomness the log recorded at the same slots, so a
  tool that takes those from `ctx` is compared on what it said rather than on
  when it was asked; a tool reading `Date.now()` directly comes back `unstable`,
  which is the honest name for what would happen to it on a fork.
- **An override is a counterfactual for the steps above it and nothing else.** Replacing a value changes what the live steps see; the replayed steps between it and the fork point still come out of the log as recorded, and are marked `stale` for it — the model calls on `conversation`, and any tool call whose input the substitution moved on `input`. The fork's log is a truthful record of a run that answered a question its parent never asked — it is not a record of what the parent would have done, because nothing re-ran to find out.

## Status

Early, and not yet on npm. The core — journal, agent loop, fork (at a step or at
one recorded call), replay, resume, budgets, store, CLI, the clock/uuid/random effects, per-component request and tool-call digests and the `stale` marking built on them, value overrides, recorded model-call failures, the HTML report, streaming, parallel tool calls, the `verify` audit and the `recheck` re-execution including its `unstable` finding, and the lineage bundles `export` and `import` move between stores — is covered by 249 tests that run without network access. GitHub Actions runs the typecheck, the suite, the build, the demo and a packing dry run on every push and pull request, on Node 22 and Node 24, with no API key in the environment — so the "no network, no key" claim above is checked rather than asserted.

The `AnthropicProvider` adapter has tests behind it. Against a stub client, they pin the request body it builds (model, tokens, system, tools, adaptive thinking, `effort`, the server-side fallback parameter and its beta), the content-block normalization in both directions, the byte-for-byte `raw` passthrough that signed thinking blocks depend on, and the reassembly of a streamed turn — text, a signature arriving in pieces, a tool's partial JSON — back into the message the unstreamed endpoint would have returned. It is still **not verified against the live API from this repo**: the two integration tests that do that — `[live]`, in `test/anthropic.test.ts` and `test/streaming.test.ts` — skip themselves when `ANTHROPIC_API_KEY` is unset, which is how they have run so far. Set a key and run them to close that gap.

## Development

```bash
npm install
npm test           # 249 tests, no network, no API key
                   # with ANTHROPIC_API_KEY set, two more run against the live API
npm run typecheck
npm run build
node examples/demo.ts   # the whole pitch, scripted, no API key
npm pack --dry-run      # what an install would actually get
```

`.github/workflows/ci.yml` runs exactly those six commands on Node 22 and 24.
Its steps are themselves under test: `test/ci.test.ts` reads the workflow and
fails if it stops running a gate, names a script `package.json` does not define,
tests a Node version below the `engines` floor, or starts supplying an API key —
because a CI file that has quietly drifted still shows a green tick.

`test/package.test.ts` does the same for `package.json`, since the one
configuration this repo never runs is the package as somebody else installs it.
It traces every entry point back to the source tsc compiles it from, fails if
`src` imports anything that is not a declared dependency, and checks the licence,
the changelog and the README's own imports against what is actually exported.
The `npm pack --dry-run` step covers the half a test cannot see — that the build
really put its output where the manifest says it did.

## License

MIT — see [LICENSE](LICENSE). Release notes are in [CHANGELOG.md](CHANGELOG.md).
