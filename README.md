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

A digest is a one-way street, so the log can name the component and not what it
moved to. The other side of the comparison is not lost, though: it is in the run
this one was forked from, which is the same log the free prefix came out of.
`retrace stale` reads both and says it:

```
$ retrace stale demo-forked

demo-forked  completed
forked from demo-original at step 3

system
  step:0, step:1, step:2
  - You are a research analyst. Cite what you searched.
  + You are a research analyst. Answer in at most ten words.

explained: 3 stale effects, and 1 change is the whole of what moved under them
```

One change, and every effect it accounts for — a prompt rewritten once is not
worth printing once per replayed step. It executes nothing and exits zero either
way, because staleness is a description rather than a failure; what it can fail
to do is *explain*, and then it says which component it could not account for
and why. A parent that is not in this store is the common one, and
[`export`](#taking-a-lineage-with-you) is the answer to it. In code it is
`explainStale(runId)`.

The component this earns its keep on is `tools`, because that is the one you did
not mean to change:

```
tools
  step:0, step:1, step:2
  - Search the corpus for a term. Call this whenever the answer depends on a fact you were not given.
  + (not declared)
```

The log records the tools a run declared, exactly as the model was shown them,
so a fork reporting `stale (tools)` can now name the tool that went missing
instead of leaving you to guess which of them the module forgot.

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

## The fork you haven't run yet

Every line `fork` prints about its prefix is something it worked out *after*
paying for a live step. It did not have to: the cut, the requests the replayed
steps would be answering, the tools the module declares, the calls the fork
point's own step would repeat — all of that is in the log and in the module
before anything executes. `plan` says it beforehand:

```bash
retrace plan demo-original --at 3 --module ./agent-module.ts
```

```
demo-original  completed
analyst · claude-opus-5 · fork at step 3

  replays   6 of 7 effects, 3 steps whole · $0.6900 of $0.9200 not spent again
  live      step 3 onward: the model call, and whatever it asks for
  stale     3 replayed model calls would answer a request this fork no longer builds — system
            step:0, step:1, step:2

nothing ran: this is the fork read off the log, before you pay for it
```

That is the same `stale (system)` the fork itself reports, arrived at the same
way: the prefix is cut where `fork` cuts it, each replayed request is rebuilt out
of this run's own effects the way [`verify`](#the-log-against-itself) rebuilds
them, and the digest recorded beside each recorded answer is what it is compared
against. What changes is when you find out — and the case worth finding out
early is the one you did not mean:

```
  stale     3 replayed model calls would answer a request this fork no longer builds — system, tools
            step:0, step:1, step:2
  tools     the log declares "search", and this module does not — a live step
            that asks for one would fail
```

`system` is the fork doing what you asked. `tools` beside it is a module that is
not the one the run was recorded against, and every live step of that fork is
about to be answered by a model that has not been shown the tool it needs.

The other half is the call a fork would refuse to make. Forking at an effect
keeps the model turn that asked, so the rest of that step's calls are exactly
what will run — and whether one of them is
[irreversible](#tools-that-cant-be-taken-back) is a question the tool answers
today rather than something the log remembers:

```
$ retrace plan demo-original --at 'step:1#0:lookup' --module ./agent-module.ts
...
  live      step:1#0:lookup onward: 2 recorded tool calls, then whatever the step
            after it asks for
  held      "send_email" at step:1#1:send_email is marked irreversible — this fork
            would stop there rather than make the call again

would not run: fork above step:1#1:send_email to replay it instead, or pass
--allow-irreversible
```

It exits non-zero on that and zero otherwise, so it works as a pre-flight check
in front of a fork. Past the fork point there is nothing for it to say: the model
has not been asked yet, and what it asks for next is the whole reason you are
forking there. Run it without `--module` and the arithmetic of the free prefix
still holds — that much is in the log — while the staleness comes back
unpredicted rather than guessed at, in the same way `verify` reports a request it
has no tools to rebuild. In code it is `planFork(runId, { atStep, tools })`.

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
`retrace stale demo-counterfactual` goes one further and names the message:

```
conversation · message 2 · user · tool_result
  step:1, step:2
  - 3 results for "market size"
  + no results
```

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

## Reading the network

The largest thing a tool does that a log could not follow used to be the one
thing most tools are *for*: going and asking something. `ctx.fetch` is `fetch`
with the answer recorded:

```ts
run: async ({ query }, ctx) => {
  const res = await ctx.fetch(`https://corpus.internal/search?q=${query}`);
  return (await res.json()).hits.join("\n");
},
```

```
$ retrace show read

step 0
  live      model  step:0  1980ms
  live      tool   step:0#0:search  412ms
        → 3 results for "pricing"
  live      fetch  step:0#0:search/fetch:0:7614deb6df66  38ms
        → GET https://corpus.internal/search?q=pricing → 200 (1284B)
```

A replay never reaches the corpus. Neither does the live tail of a fork, where
the call executes for real and its `fetch` comes back out of the log — which is
what makes a fork a controlled experiment rather than a second run: the fork
differs from its parent in the thing you changed, and the world it ran in is the
world its parent ran in.

Status, status text, headers, body and `url` all round-trip, and the `Response`
a tool is handed is built the same way on both passes, so a tool cannot behave
one way while being recorded and another way afterwards. A body that is text
goes in the log as text and stays readable; bytes that are not text go in as
base64. A fetch that *rejected* is recorded too and rejects again on replay, so
a run that died because a host was down does not replay into one that reached
it.

What keeps this from being a cache that lies: the key carries a digest of the
request as well as the slot. `step:0#0:search/fetch:0:5d8f110cfaa9` is the first
fetch of that call *asking that question*, so a live call asking something else
finds nothing there and goes to the network, rather than being handed the
parent's answer to a question it did not ask. Method, URL and a text body are
what that digest covers; a stream or a blob body is not, and two calls differing
only there share a slot.

The other half is the tools that don't use it. `fetch` is watched exactly as the
clock and the RNG are, so a tool that reaches for the global one is recorded with
what it reached for:

```
$ retrace verify read

  fail ambient      1 of 3 tool calls read the network outside the journal
                    (step:0#0:search) — a fork replays what they said once,
                    which is not what they would say again
```

`recheck` is the one command that deliberately does *not* serve a recorded
response. Whether the world still says what the log holds is the question it
exists to ask, so its network reads go live while the clock, the ids and the
randomness stay pinned to what the run recorded — which leaves the network as
the only thing a disagreement can be about.

## Time, ids and randomness

A tool's second argument is the journal — [`ctx.fetch`](#reading-the-network)
above, and three smaller reads. Anything taken from it is recorded and comes
back unchanged later:

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
RNG. The journal only covers what you take from it — but it now *notices* when a
tool goes around it:

```
$ retrace show snapshot

step 0
  live      tool   step:0#0:stamp  2ms  reads clock
            → filed at 1786988483725
```

While a tool body runs, `Date.now()`, `new Date()`, `Math.random()`,
`crypto.randomUUID()` and `fetch` are watched. A call that reaches one is
recorded with what it reached for, so the log itself says which of its answers
are snapshots rather than answers — the tool would not give that value again, and every fork off this
run will replay it as though it would.

```
$ retrace replay snapshot

1 tool call read the clock outside the journal: step:0#0:stamp
  what the log holds for it is a snapshot, not something a replay reproduces —
  take these from ctx instead
```

It is a marking on the effect, so `show`, the HTML report and
[`verify`](#checking-a-log-against-itself) all carry it, and a fork carries it on
every recorded call in the prefix it replayed. Watching costs the run nothing:
the wrappers delegate to the real implementations, observe, and come down when
the last tool body returns. `new Date(ms)` is arithmetic on a number you already
had and is not a clock read; only the zero-argument form is.

Two things it cannot see. `randomUUID` imported from `node:crypto` is a binding
rather than a global, and a tool that reads the clock inside a subprocess or
behind a native HTTP client is somewhere no wrapper reaches. Both come back clean here and
are what [`recheck`](#checking-a-log-against-the-world) is still for: it executes
a disagreeing call twice and reports `unstable` on what it cannot pin down. This
is the cheaper half of the same question, answered while the run is being
recorded rather than after.

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

Time, ids and fetches survive the same way, because a `ctx.now()` read resolves
by key rather than by whoever reached it first: `step:0#1:search/clock:0` is the
same slot no matter when in the batch it was read, and a response lands under
the call that asked for it however late the corpus was in answering.

It is off by default, and the reason is in the name of the guarantee. The *log*
is deterministic; the *side effects* aren't. Four reads overlapping is fine; two
tools writing to the same row is a race you have introduced, and the journal
will faithfully record whichever result it produced.

Two other things change with it on. Replayed calls are never parallelized —
there is nothing to overlap when nothing executes — so in a fork only the live
tail of a step runs at once. And the batch is charged against
`budget.toolCalls` before any of it starts, so a step that cannot afford all its
calls makes none of them, rather than leaving half a step in the log.

## Tools that can't be taken back

Everything here works because a replayed call returns the recorded answer without
executing. The live tail of a fork is where that stops being true: it is the
second time the run has reached that call, and the first time was real. A
`send_email` there sends the email again.

Mark the tool, and the runtime stops rather than sending it:

```ts
const sendEmail = tool({
  name: "send_email",
  description: "Send an email. Call this once the answer is ready to go out.",
  inputSchema: objectSchema({ to: { type: "string" } }),
  irreversible: true,
  run: async ({ to }) => mailer.send(to),
});
```

```
$ retrace fork demo-original --at 'step:1#0:send_email' --module ./agent-module.ts
...
finished failed
  "send_email" is marked irreversible and this run would execute it live at
  "step:1#0:send_email". This run re-entered a recorded one, so the call would
  do the thing a second time, for real. Fork at step 2 or later to replay the
  recorded result instead, or pass allowIrreversible (--allow-irreversible) to
  execute it.
```

Both ways out are in the message, and they are answers to different questions.
Fork above the call and it comes out of the log like anything else in a replayed
prefix — that is the fork that wanted the steps *after* the mail, not the mail.
`--allow-irreversible` is the one that means send it.

A fresh run never asks, because there is nothing to repeat; the mark costs
nothing until you re-enter the run. A fork, a resume, or a replay that outlives
its log is where it bites — [resume](#picking-a-run-back-up) being the case the
caveat was always really about, where the tool may have done its work and died
before the log could say so.

The whole of a step's live tail is checked before any of it runs, so a step that
asks for a search and a send makes neither call rather than leaving half of one
in the log. And the mark is a claim the tool makes about itself today, not
something the log remembers: take it off the tool in your module and the call
executes.

[`recheck`](#checking-a-log-against-the-world) holds the same tools back, for a
sharper version of the same reason — re-executing recorded calls is the whole of
what it does:

```
  same    step:0#0:lookup      {"term":"alpha"}
  held    step:1#0:send_email  {"to":"reader@example.com"}

still true as far as it goes: 1 of 2 recorded tool calls re-executed and agreed;
1 call a tool marked irreversible, which was held back rather than repeated
```

Naming it with `--tool` is not consent: that flag narrows which tools run, and
this one has already said what it thinks about being run. `--allow-irreversible`
is the consent there too.

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
retrace diff <run-a> <run-b>  # where two runs stopped agreeing, and where they can't
retrace replay <run-id>       # re-run it from the log and check it reproduces
retrace fork <run-id> --at N  # replay the steps below N, then run live
retrace fork … --at <key>     # …or re-enter mid-step, at one recorded call
retrace fork … --set k=v      # …serving v in place of the effect recorded at k
retrace plan <run-id> --at N  # what that fork would replay, save and go stale on
retrace resume <run-id>       # carry on a run that stopped early, from its log
retrace stale <run-id>        # what moved under the steps it replayed, and to what
retrace report <run-id>       # write the run as one self-contained HTML page
retrace verify <run-id>       # hold the log to itself, to its own claims, and to its parent
retrace recheck <run-id>      # …and ask the tools whether its answers still hold
retrace export <run-id>       # the run and everything it was forked from, as one file
retrace import <path>         # …read back into a store, so verify runs whole there
```

`diff` is the one to reach for after a fork — it shows exactly which effect the
two runs stopped sharing, and holds them to the prefix they didn't. See
[checking two logs against each other](#checking-two-logs-against-each-other).

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
inside a step](#forking-inside-a-step). `retrace plan` takes the same two
options, executes none of it, and says what that fork would replay, save and go
stale on — see [the fork you haven't run yet](#the-fork-you-havent-run-yet).

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
  ok   requests     7 calls answer the request this log rebuilds, digest for digest
  ok   accounting   $0.9200 at list price, $0.2300 billed, $0.6900 saved — the charges add up
  ok   free replay  6 of 7 effects came out of the log, and none of them was billed
  ok   markings     3 stale (system), 0 substituted, all of them served from the log
  ok   ambient      3 tool calls, none of which read a clock, an id, an RNG or the
                    network outside ctx
  ok   parent       6 replayed effects are demo-original's, value for value
  ok   lineage      6 free effects trace back to demo-original, which executed and paid for them

verified: this log holds up against everything it claims
```

`ambient` is the odd one out, and the only check here that is about the future
rather than the past. Everything else holds the log to something that already
happened; this one asks whether the answers in it are answers a replay could get
again. A tool that read `Date.now()` — or reached the network through the global
`fetch` rather than `ctx.fetch` — while it ran recorded what the world happened
to say once, and it fails:

```
  fail ambient      1 of 3 tool calls read the clock outside the journal
                    (step:0#0:stamp) — a fork replays what they said once, which
                    is not what they would say again
```

`parent` is the one worth having. Every effect this run served from the log is
looked up in the run it says it came from and compared value for value, so an
edited prefix, a spliced log or a fork pointed at the wrong parent stops being
something you take on trust. The rest hold the log to its own arithmetic: the
charges add up to the totals it reports, nothing served from the log was billed
or claims to have taken time, and nothing that executed is marked `stale` or
`overridden`.

### The log against itself

Every check named so far compares one log with another, which leaves the run at
the top of a lineage checked by nothing. Edit what a search returned at step 0 of
the original and `parent` still holds — the fork replayed the edited value
faithfully — `lineage` still traces it back to the run that paid, and the money
still adds up. A lineage that verifies, rooted in a run that never happened.

A log can be held to itself, though, because it holds both halves. Beside every
recorded answer is [a digest of what was
asked](#what-a-replayed-step-is-still-answering), and what was asked is the
conversation the earlier answers build — so the request can be rebuilt from the
log and compared against the digest recorded with it. That is `requests`, and it
is the agent loop with the provider and the tools taken out: start from the
input, replay each recorded response into an assistant turn, turn each recorded
tool result into the message the model saw next.

```
  fail requests     model:step:1 was recorded against a request this log does not build — conversation moved
```

Step 1 was recorded against a step 0 this log no longer contains. The same
comparison names `system`, `model`, `tools` or `settings` when the agent spec has
been edited under a run, `input` when a tool call holds the answer to a question
the response above it does not ask, and reports an effect nothing in the log asks
for when one has been spliced in. It needs no store, no parent and no network, so
it is the check that still runs on a log attached to a bug report.

What it does *not* do is decide who edited what. The fork above verifies clean
and should: it was served that value and built its requests around it, so its log
is a truthful record of the run it had. The edit is caught in the log where it
was made.

Two things it declines to guess at, in the usual way. A log written before runs
recorded [their tool declarations](#storage) has no tools to rebuild a request
from and comes back skipped rather than reporting every call as edited. So does
one whose calls carry no digest at all; one with digests and no per-component
facets says a request moved and not which part of it, exactly as `stale` does.

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

### Checking two logs against each other

`diff` is the command to reach for after a fork. It lines the two runs up effect
by effect and shows where they stopped agreeing:

```
$ retrace diff demo-original demo-forked

demo-original  completed  ·  demo-forked  completed
demo-forked forked from demo-original at step 3

    0–5 = 6 shared
      6 ≠ model:step:3 — same call, different result

free      6 effects demo-forked replayed from demo-original, value for value
diverges  at effect 6, the first effect either run ran for itself
ended     both completed, with different answers
billed    $0.9200 → $0.2300
```

The bottom half is the part that is a check rather than a description. Where the
two part ways is a fact about your change and nothing to complain about —
diverging is what a fork is *for*. What is not free to differ is everything
*below* that: a fork bills nothing for its prefix because the prefix came out of
the run it was forked from, and two runs cannot have taken different values out
of the same log. `free` is how many effects that covers, and whether they hold.

Which makes it the answer to the one thing
[`verify`](#checking-a-log-against-itself) gives up on. A fork read on a machine
that has never seen its parent is a free prefix with nothing to check against,
and `verify` says so and exits zero:

```
  --   parent   the run it came from ("demo-original") is not in this store, so its prefix is unchecked
  --   lineage  nothing this run got free can be traced to the run that ran it: the trail stops where "demo-original" is not in this store
```

Two forks of that run check *each other* instead. They replayed the same prefix
out of the same log, so they have to agree on it, and establishing that needs
only the two logs in front of you:

```
$ retrace diff demo-forked demo-counterfactual

free      6 effects both replayed from demo-original: 5 value for value, 1 substituted on purpose
```

Five, not six, because one of them is a
[counterfactual](#what-if-it-had-said-something-else): an override serves a
value the parent never recorded, so that is the one position the two are meant
to disagree at. Every other effect between it and the fork point still came out
of the log unchanged, which is why the substitution excuses a position rather
than ending the claim. Doctor one of those and it has nowhere to hide:

```
contradicted: effect 3 (tool:step:1#0:search) differs, and demo-forked and
demo-counterfactual both replayed it from demo-original — two runs cannot have
taken different values out of the same log
```

That is the whole of what it exits non-zero on. Two runs with no relation
between them owe each other nothing, and it says so rather than inventing a
claim to fail; so does a fork at step 0, which replayed nothing. Only the direct
relations count — one run forked, resumed or replayed from the other, or both
from the same run — because a log names the run it came from and nothing
further. Cousins need the logs in between, and that is `verify`'s lineage walk.
In code it is `compareRuns(a, b)`.

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
rather than running. A tool marked
[`irreversible`](#tools-that-cant-be-taken-back) is reported `held` instead of
run, and `--tool <name>` is repeatable and limits execution to the tools you
name, which between them is how you re-check the reads and leave the writes
alone. It exits non-zero when something moved, so it can gate a pipeline. In code
it is `recheckRun(runId, { tools })`.

## Storage

Runs are JSONL under `.retrace/runs/<run-id>.jsonl`, one event per line, appended synchronously. If the process dies mid-run the log is still a truthful prefix — a torn final line is dropped on read, and everything before it stands — and a truthful prefix is enough to [pick the run back up](#picking-a-run-back-up). `MemoryStore` is the same interface with nothing on disk.

The log holds normalized, provider-agnostic content, plus the provider's own blocks verbatim (thinking blocks are signed and have to be echoed back byte-for-byte). A response a tool fetched through `ctx.fetch` is flattened into the parts a tool can read back out — status, status text, headers and body — because a `Response` is a one-shot stream over a socket that is closed long before anyone replays it. A run recorded today still replays after the SDK's types change underneath it. It also holds the tool declarations the run was recorded with, as the model was shown them — the agent spec carries the model and the prompt but never those, and without them a `stale (tools)` marking is the one staleness nothing could follow up.

## Determinism, honestly

Retrace guarantees the *agent loop* is deterministic given its journal. It does not make your tools deterministic. Specifically:

- **Tool side effects are real.** A replayed tool call returns the recorded
  result without executing, which is the point — but a fork that goes live past a
  `send_email` tool will send the email again. `irreversible: true` on the tool
  is how you say so, and then a fork, a resume or a replay that outlives its log
  stops and names the call rather than making it; `--allow-irreversible` is how
  you say you meant it. That is a gate you have to remember to fit, not one the
  runtime can infer: an unmarked tool is executed, because the mark is the tool's
  claim about itself and there is nothing else to read it from.
- **A resume re-runs the tool call that was in flight when the run died.** Its result never reached the log, so as far as the log is concerned it never ran — and the log is all `resume` has. A tool that had already done its work and was killed before returning does that work twice. This is the same hazard as the bullet above, arriving at the one moment you are least likely to be thinking about it — and the one the mark above is most worth having for, since the run that died is the one you had least warning about.
- **Tools run sequentially by default**, in the order the model requested them. `parallelTools` overlaps them and still records deterministically — results are journaled in request order, and time and ids resolve by key — but the side-effect ordering isn't, which is why it is opt-in rather than on.
- **Network reads are journaled only if you take them from the tool context.**
  `ctx.fetch` records the response — status, headers, body, and a rejection —
  and hands it back on a replay and in the live tail of a fork, so a run's
  answers stop depending on a corpus that has moved since. What it covers is
  `fetch`: a tool reaching the network through a native client, a database
  driver or a subprocess is outside it, and comes back marked only where the
  global `fetch` is what it used. Its slot carries a digest of method, URL and
  a text body, so a call asking something else goes live rather than being
  handed the wrong answer — but a request that differs only in a stream or a
  blob body shares a slot with the one recorded there. And a recorded response
  is a snapshot of what the corpus said then: that is the point on a fork, and
  it is exactly what [`recheck`](#checking-a-log-against-the-world) refuses to
  serve, since asking whether it still holds is the one thing that command is
  for.
- **Clock and randomness are journaled only if you take them from the tool
  context.** `ctx.now()`, `ctx.uuid()` and `ctx.random()` are recorded and
  stable; a tool that calls `Date.now()` directly still reads the real clock and
  may branch differently when it goes live. Nothing can make such a tool
  replayable short of taking the value from `ctx` — but the log no longer has to
  be silent about it. The ambient clock, `Date`, `Math.random`,
  `crypto.randomUUID` and `fetch` are watched while a tool body runs, and a call
  that reaches one is recorded with what it reached for, so `show`, the report
  and `verify`'s `ambient` check all name the calls whose recorded answers are
  snapshots. The watch is scoped to the moments a tool is executing and only
  observes; what it costs is the identity of `globalThis.Date` for those moments,
  since telling `new Date()` from `new Date(ms)` needs the constructor. `fetch`
  is taken from the global at that moment rather than at load, so a caller that
  has installed its own is not quietly restored to the original. Two ways out
  remain: `randomUUID` imported from `node:crypto` is a binding rather than a
  global, and a read in a subprocess or through a client that does not go
  through `globalThis.fetch` is somewhere no wrapper goes. [`recheck`](#checking-a-log-against-the-world) is the check that still
  catches those, by executing a disagreeing call a second time against the same
  recorded reads and reporting `unstable` rather than `moved`.
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
- **The digest behind `stale` covers what was asked, not the world.** For a model call that is the request: model, system prompt, tools, conversation, token and thinking settings — all of it, and each of them separately, so the log names which one moved rather than only that one did. For a tool call it is the input the model supplied, under the facet `input`. A tool that returns something different today because a database moved underneath it is not something either digest can see. Nor is the list itself a diff — a digest is one-way, so one log can say the system prompt changed and never what it changed to. Two can: [`retrace stale`](#what-a-replayed-step-is-still-answering) rebuilds both requests component by component from this run's log and its parent's, and reports the difference the digests could only point at. It needs the parent in the store, and says which component it could not account for when it isn't there.
- **A tool call's digest is a check on the question, not on the tool.** It catches the case where a replayed tool call is handed the parent's answer to a call this run does not make — which happens when a model response above it was [replaced](#what-if-it-had-said-something-else), and essentially never otherwise. It says nothing about whether the recorded result is still what the tool would return — that question needs the tool rather than the log, and [`recheck`](#checking-a-log-against-the-world) is what asks it. Tool calls recorded before this existed carry no digest and are reported clean rather than guessed at, exactly as older model calls are.
- **A log recorded before the per-component digests still compares, and still won't guess.** Staleness is decided by the whole-request digest, which has not changed, so an older log detects it exactly as before; it simply has no components to compare, and reports `stale` with nothing named rather than naming something it did not check.
- **`plan` describes a fork without making it, and only from what the log
  already holds.** It cuts the log where the fork will cut it, rebuilds the
  requests the replayed prefix would be answering out of the run's own effects,
  and compares them against the digests recorded beside the answers — so the
  `stale` line it prints is the line the fork will print, arrived at for nothing.
  What it cannot describe is anything above the fork point: the model has not
  been asked, so what the live steps will call, what they will cost and whether
  any of it is irreversible are in no log. The exception is a fork point inside a
  step, where the turn that asked is replayed and the calls it asked for are
  therefore already known — which is exactly the case the `irreversible` check
  matters in. It is a prediction and not a promise: the world can move between
  planning a fork and running one, and [`recheck`](#checking-a-log-against-the-world)
  is the command that asks whether it has.
- **`verify` checks the log against the log.** It proves that a fork's free
  prefix is the prefix its parent recorded, that following the chain up leads to
  a run that executed and was billed for it, that the money adds up to the
  savings claimed, and — in `ambient` — that no tool call in it took its time,
  its ids, its randomness or its answers off the network from somewhere a
  replay cannot follow. It cannot
  tell you the recorded values were the right answers, or that a tool asked the
  same question today would still say the same thing — nothing that reads only a
  log can. `recheck` executes the tools and
  answers the second of those; the first is not a question anything here settles.
  And `verify` can only follow a lineage as far as the logs it has: a chain that
  leaves the store is traced to that point and reported skipped, not passed —
  which is a fact about the store rather than about the run, and
  [`export`](#taking-a-lineage-with-you) is how you hand it the rest.
- **One of `verify`'s checks holds a log to itself rather than to another log.**
  `requests` rebuilds every request the run made out of the run's own effects and
  compares it against the digest recorded beside each answer, which is what makes
  the log at the top of a lineage checkable at all — every other check would pass
  an edit made there, and so would every fork that faithfully replayed it. It
  catches a value edited, reordered or spliced into a log, and an agent spec
  changed under one after the fact. It does not catch a value that was wrong when
  it was recorded, because a digest can only say that two requests differ; and it
  is silent, deliberately, about logs written before the digests existed. It is
  also not an accusation: a run that was *served* an edited value and built its
  requests around it verifies clean, correctly, because its log is a truthful
  record of the run it had. In code it is `rebuildRequests(events)`.
- **`diff` checks two logs against each other, one hop at a time.** Two runs
  that both replayed a stretch of the same log cannot hold different values
  across it, and that is checkable from the two logs alone — which is what makes
  it the check that still works when the run they came from is gone, where
  `verify` reports its lineage skipped. It only claims the relations a log
  names directly: one run forked, resumed or replayed from the other, or both
  from the same run. Two runs further apart than that are compared and held to
  nothing, because the logs in between are where the connection lives, and
  `verify` is what walks them. Everything above the shared prefix is a
  description and not a verdict — a fork that diverges from its parent at the
  fork point is a fork working.
- **`recheck` executes your tools, on purpose.** It is the one command here that
  reaches the world by design, so a recorded `send_email` is sent again unless it
  is marked `irreversible` or `--tool` keeps it out of the run — and a call that
  disagrees with the log is
  executed *twice*, since asking again is what separates a moved corpus from a
  tool with no settled answer. A call that agreed is asked once. It hands each
  call the clock, ids and randomness the log recorded at the same slots, so a
  tool that takes those from `ctx` is compared on what it said rather than on
  when it was asked; a tool reading `Date.now()` directly comes back `unstable`,
  which is the honest name for what would happen to it on a fork. `ctx.fetch` is
  the one read it does *not* serve from the log: everything else is pinned so
  that the network is the only thing a disagreement can be about, which is what
  makes a tool that reads the world through `ctx.fetch` the tool this command
  can be precise about.
- **An override is a counterfactual for the steps above it and nothing else.** Replacing a value changes what the live steps see; the replayed steps between it and the fork point still come out of the log as recorded, and are marked `stale` for it — the model calls on `conversation`, and any tool call whose input the substitution moved on `input`. The fork's log is a truthful record of a run that answered a question its parent never asked — it is not a record of what the parent would have done, because nothing re-ran to find out.

## Status

Early, and not yet on npm. The core — journal, agent loop, fork (at a step or at
one recorded call), replay, resume, budgets, store, CLI, the clock/uuid/random effects, the journaled `ctx.fetch` that brings a tool's network reads inside the boundary, per-component request and tool-call digests, the `stale` marking built on them and the `stale` command that reads a run against its parent to say what moved, value overrides, recorded model-call failures, the HTML report, streaming, parallel tool calls, the `verify` audit including the `requests` check that rebuilds a run's own requests from its own log, the `diff` comparison that holds two logs to the prefix they claim from the same source, and the `recheck` re-execution including its `unstable` finding, the watch on the
ambient clock, RNG and `fetch` that says at record time which tool answers are snapshots, the lineage bundles `export` and `import` move between stores, the `irreversible` mark that stops a re-entered run from repeating a call the world cannot take back, and the `plan` command that says what a fork would replay, save, go stale on and refuse before any of it is paid for — is covered by 376 tests that run without network access. GitHub Actions runs the typecheck, the suite, the build, the demo and a packing dry run on every push and pull request, on Node 22 and Node 24, with no API key in the environment — so the "no network, no key" claim above is checked rather than asserted.

The `AnthropicProvider` adapter has tests behind it. Against a stub client, they pin the request body it builds (model, tokens, system, tools, adaptive thinking, `effort`, the server-side fallback parameter and its beta), the content-block normalization in both directions, the byte-for-byte `raw` passthrough that signed thinking blocks depend on, and the reassembly of a streamed turn — text, a signature arriving in pieces, a tool's partial JSON — back into the message the unstreamed endpoint would have returned. It is still **not verified against the live API from this repo**: the two integration tests that do that — `[live]`, in `test/anthropic.test.ts` and `test/streaming.test.ts` — skip themselves when `ANTHROPIC_API_KEY` is unset, which is how they have run so far. Set a key and run them to close that gap.

## Development

```bash
npm install
npm test           # 376 tests, no network, no API key
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
