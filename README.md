# Retrace

**Agent runs are event logs you can rewind.** Record a run once, then replay it exactly, or fork it from any step — the prefix comes out of the log for free and execution goes live from the point you changed.

The usual way to debug an agent is to run it again and hope. A twelve-step run that went wrong at step nine costs you nine steps of tokens and nine steps of latency every time you want to try a different prompt. Retrace makes those nine steps free.

```
$ npx retrace show demo-forked

demo-forked  completed
analyst · claude-opus-5 · via anthropic
forked from demo-original at step 3

step 0
  replayed  model  step:0
  replayed  tool   step:0#0:search
            → 3 results for "market size"
step 1
  replayed  model  step:1
  replayed  tool   step:1#0:search
            → 3 results for "competitors"
step 2
  replayed  model  step:2
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

## Install

```bash
npm install retrace
```

Requires Node 22.6+ and an `ANTHROPIC_API_KEY`.

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

Or verify a run reproduces exactly:

```ts
import { replay } from "retrace";

const again = await replay(result.runId, { provider, tools: [search] });
// Reaches neither the model nor the tools. Same output, $0.
```

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
```

`diff` is the one to reach for after a fork — it shows exactly which effect the two runs stopped sharing.

### Re-running from the command line

`replay` needs nothing but the log. It re-runs the recorded loop, reaches neither the model nor your tools, and then compares what came out against what went in:

```
$ retrace replay demo-original
...
new run replay_20260812163416_838c0f5e
reproduced 7 effects, identical · $0.9200 not spent
```

It exits non-zero if the replay diverged, ended differently, or ran past the end of the log — so it works as a regression check on the loop itself.

`fork` has to execute the steps above the fork point, and a log cannot hold a running tool. `--module` supplies that half; everything else — input, model, budget — comes from the recorded run:

```ts
// agent-module.ts
export const tools = [search];
export const provider = new AnthropicProvider();
export const agent = { system: "You are a research analyst. Answer in ten words." };
```

```bash
retrace fork demo-original --at 3 --module ./agent-module.ts
```

Named exports and a `default` object both work. The file is imported for its exports, so it must not run anything at import time — see `examples/research.ts`, which guards its runner behind an entry-point check for exactly that reason. `--module` is optional for `replay`, and only matters there if the log stops short of the run it recorded.

Add `--on-divergence live` to either command to treat a log that disagrees with the loop as the fork point rather than an error.

## Storage

Runs are JSONL under `.retrace/runs/<run-id>.jsonl`, one event per line, appended synchronously. If the process dies mid-run the log is still a truthful prefix, and a truthful prefix is enough to fork from. `MemoryStore` is the same interface with nothing on disk.

The log holds normalized, provider-agnostic content, plus the provider's own blocks verbatim (thinking blocks are signed and have to be echoed back byte-for-byte). A run recorded today still replays after the SDK's types change underneath it.

## Determinism, honestly

Retrace guarantees the *agent loop* is deterministic given its journal. It does not make your tools deterministic. Specifically:

- **Tool side effects are real.** A replayed tool call returns the recorded result without executing, which is the point — but a fork that goes live past a `send_email` tool will send the email again. Gate irreversible tools yourself.
- **Tools run sequentially**, in the order the model requested them. Parallel execution would still record deterministically, but the side-effect ordering wouldn't be, so it isn't the default.
- **Clock and randomness inside your tools are not journaled.** Only the tool's *return value* is. A tool that returns `Date.now()` replays fine; a tool that branches on the clock internally may take a different path when it goes live.
- **Changing `input` on a fork with `atStep > 0` does nothing for the replayed steps** — those model calls come from the log, which was produced with the old input. Fork at 0 to change the input.

## Status

Early. The core — journal, agent loop, fork, replay, budgets, store, CLI — is covered by 52 tests that run without network access.

The `AnthropicProvider` adapter now has tests behind it. Against a stub client, they pin the request body it builds (model, tokens, system, tools, adaptive thinking, `effort`, the server-side fallback parameter and its beta), the content-block normalization in both directions, and the byte-for-byte `raw` passthrough that signed thinking blocks depend on. It is still **not verified against the live API from this repo**: the integration test that does that — `[live]` in `test/anthropic.test.ts` — skips itself when `ANTHROPIC_API_KEY` is unset, which is how it has run so far. Set a key and run it to close that gap.

## Development

```bash
npm install
npm test           # 52 tests, no network, no API key
                   # with ANTHROPIC_API_KEY set, one more runs against the live API
npm run typecheck
npm run build
node examples/demo.ts   # the whole pitch, scripted, no API key
```

## License

MIT
