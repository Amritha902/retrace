/**
 * A run log, rendered as one self-contained HTML page.
 *
 * The report is built from the log alone and contains no scripts and no
 * external references, so it can be mailed, committed, or opened from a file://
 * path years later and still look like itself. It is also deterministic: the
 * same log renders byte-for-byte the same page, which matters for a project
 * whose whole claim is that a recorded run reproduces.
 */
import { formatUsd } from "./pricing.ts";
import { effectsOf, type RunSummary } from "./replay.ts";
import type { ContentBlock, ModelResponse, RetraceEvent, Usage } from "./types.ts";

type Effect = Extract<RetraceEvent, { type: "effect" }>;
type Charge = Extract<RetraceEvent, { type: "charge" }>;

/** What a tool call returns through the journal. */
interface ToolOutcome {
  content: string;
  isError: boolean;
}

export function renderReport(summary: RunSummary, events: readonly RetraceEvent[]): string {
  const effects = effectsOf(events);
  const charges = events.filter((e): e is Charge => e.type === "charge");

  return [
    "<!doctype html>",
    `<html lang="en"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>retrace · ${escape(summary.runId)}</title>`,
    `<style>${STYLE}</style>`,
    `</head><body><main>`,
    masthead(summary, effects),
    ledger(summary, events),
    timeline(summary, effects, charges),
    ending(summary),
    colophon(summary, events),
    `</main></body></html>`,
    "",
  ].join("\n");
}

function masthead(summary: RunSummary, effects: readonly Effect[]): string {
  const replayed = effects.filter((e) => e.replayed).length;
  const stale = effects.filter((e) => e.stale).length;
  const set = effects.filter((e) => e.overridden).length;
  const from = summary.forkedFrom;

  return section("masthead", [
    `<p class="eyebrow">retrace run report</p>`,
    `<h1>${escape(summary.runId)}</h1>`,
    `<p class="meta">${statusPill(summary.status)}<span>${escape(summary.agent.name)}</span>` +
      `<span class="sep">·</span><span>${escape(summary.agent.model)}</span>` +
      `<span class="sep">·</span><span>via ${escape(summary.provider)}</span>` +
      `<span class="sep">·</span><span>${escape(isoTime(summary.startedAt))}</span></p>`,
    from
      ? `<p class="lineage">forked from <span class="mono">${escape(from.runId)}</span> at step ` +
        `${escape(String(from.atStep))}</p>`
      : "",
    `<p class="lede">${lede(replayed, effects.length, summary)}</p>`,
    set > 0
      ? `<p class="note">${set} of them did not come back as recorded: this run was asked ` +
        `what would happen if they were different. They are marked <em>set</em> below.</p>`
      : "",
    stale > 0
      ? `<p class="note">${stale} of them answer a request this run no longer builds — a prompt ` +
        `or a tool changed above them. They are marked <em>stale</em> below.</p>`
      : "",
    `<blockquote class="input">${escape(summary.input)}</blockquote>`,
  ]);
}

/** The one sentence worth reading if you read nothing else on the page. */
function lede(replayed: number, total: number, summary: RunSummary): string {
  const saved = summary.totals?.savedUsd ?? 0;
  if (total === 0) return "This run recorded no effects.";
  if (replayed === 0) {
    return `All ${total} effects ran live. Nothing here came out of a log.`;
  }
  const money = saved > 0 ? ` — ${escape(formatUsd(saved))} of list price never spent` : "";
  return `${replayed} of ${total} effects were served from a log rather than executed${money}.`;
}

function ledger(summary: RunSummary, events: readonly RetraceEvent[]): string {
  const totals = summary.totals ?? provisionalTotals(events);
  const cells = [
    stat("steps", String(totals.steps)),
    stat("tool calls", String(totals.toolCalls)),
    stat("wall clock", duration(totals.wallClockMs)),
    stat("list price", formatUsd(totals.costUsd)),
    stat("billed", formatUsd(totals.billedUsd)),
    stat("saved", formatUsd(totals.savedUsd), totals.savedUsd > 0 ? "saved" : ""),
  ];
  const caveat = summary.totals
    ? ""
    : `<p class="note">This run has no finish event: the figures above are what the log got to before it stopped.</p>`;
  return section("ledger", [`<div class="stats">${cells.join("")}</div>`, caveat]);
}

/**
 * Totals for a log that stops before its run does — a crash, a kill, a run
 * still in flight. Counted off the events rather than left blank, because a
 * truthful prefix is still worth reading.
 */
function provisionalTotals(events: readonly RetraceEvent[]) {
  const charges = events.filter((e): e is Charge => e.type === "charge");
  const first = events[0];
  const last = events[events.length - 1];
  return {
    steps: events.filter((e) => e.type === "step.started").length,
    toolCalls: effectsOf(events).filter((e) => e.kind === "tool").length,
    costUsd: charges.reduce((sum, c) => sum + c.costUsd, 0),
    billedUsd: charges.reduce((sum, c) => sum + c.billedUsd, 0),
    savedUsd: charges.reduce((sum, c) => sum + c.costUsd - c.billedUsd, 0),
    wallClockMs: first && last ? last.t - first.t : 0,
  };
}

function timeline(
  summary: RunSummary,
  effects: readonly Effect[],
  charges: readonly Charge[],
): string {
  const steps = [...new Set(effects.map((e) => e.step))].sort((a, b) => a - b);
  if (steps.length === 0) {
    return section("timeline", [`<p class="note">The log holds no effects to show.</p>`]);
  }

  const requests = toolRequests(effects);
  const body = steps.map((step) => {
    const own = effects.filter((e) => e.step === step);
    const charge = charges.find((c) => c.step === step);
    return [
      `<section class="step">`,
      `<div class="ordinal">${step}</div>`,
      `<div class="cards">`,
      cardsFor(step, own, requests).join(""),
      charge ? chargeLine(charge, own) : "",
      `</div></section>`,
    ].join("");
  });

  return section("timeline", [
    `<h2>Timeline</h2>`,
    `<p class="note">${escape(summary.agent.name)} ran ${steps.length} step` +
      `${steps.length === 1 ? "" : "s"}. Each row is one effect that crossed the journal boundary.</p>`,
    body.join(""),
  ]);
}

/**
 * The input each tool call was made with, keyed the way the loop keys the call
 * itself. It lives in the model's `tool_use` block rather than in the tool
 * effect, which records only what came back.
 */
function toolRequests(effects: readonly Effect[]): Map<string, ContentBlock & { type: "tool_use" }> {
  const requests = new Map<string, ContentBlock & { type: "tool_use" }>();
  for (const effect of effects) {
    if (effect.kind !== "model") continue;
    const uses = (effect.value as ModelResponse).content.filter(
      (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
    );
    uses.forEach((use, ordinal) => {
      requests.set(`step:${effect.step}#${ordinal}:${use.name}`, use);
    });
  }
  return requests;
}

function cardsFor(
  step: number,
  effects: readonly Effect[],
  requests: Map<string, ContentBlock & { type: "tool_use" }>,
): string[] {
  const cards: string[] = [];
  const served = new Set<string>();

  for (const effect of effects) {
    // Reads a tool made are rendered inside the tool's own card, not beside it.
    if (effect.key.includes("/")) continue;

    if (effect.kind === "model") {
      cards.push(modelCard(effect));
      continue;
    }
    if (effect.kind === "tool") {
      served.add(effect.key);
      const nested = effects.filter((e) => e.key.startsWith(`${effect.key}/`));
      cards.push(toolCard(effect, requests.get(effect.key), nested));
      continue;
    }
    cards.push(readCard(effect));
  }

  // A tool the model asked for that never made it into the log: the run was cut
  // off between the request and the call. Saying so beats dropping it silently.
  for (const [key, use] of requests) {
    if (served.has(key) || !key.startsWith(`step:${step}#`)) continue;
    cards.push(
      card("unrun", [
        rowHead(badge("not run", "unrun"), "tool", key, undefined),
        `<p class="call"><span class="mono">${escape(use.name)}</span></p>`,
        json(use.input),
        `<p class="note">The model requested this call; the run ended before it was made.</p>`,
      ]),
    );
  }

  return cards;
}

function modelCard(effect: Effect): string {
  const response = effect.value as ModelResponse;
  const blocks = response.content;
  const said = blocks.filter((b): b is ContentBlock & { type: "text" } => b.type === "text");
  const thought = blocks.filter(
    (b): b is ContentBlock & { type: "thinking" } => b.type === "thinking",
  );

  return card(effect.replayed ? "replayed" : "live", [
    rowHead(mark(effect), "model", effect.key, effect.durationMs),
    `<p class="facts">${escape(response.model)}<span class="sep">·</span>` +
      `${escape(response.stopReason)}<span class="sep">·</span>${tokens(response.usage)}` +
      (response.raw === undefined
        ? ""
        : `<span class="sep">·</span><span title="the provider's own blocks, kept verbatim">raw kept</span>`) +
      `</p>`,
    thought.length > 0
      ? `<details class="thinking"><summary>thinking</summary><pre>${escape(
          thought.map((b) => b.thinking).join("\n\n"),
        )}</pre></details>`
      : "",
    said.length > 0 ? `<div class="says">${paragraphs(said.map((b) => b.text).join(""))}</div>` : "",
  ]);
}

function toolCard(
  effect: Effect,
  request: (ContentBlock & { type: "tool_use" }) | undefined,
  nested: readonly Effect[],
): string {
  const outcome = effect.value as ToolOutcome;
  const name = effect.key.slice(effect.key.indexOf(":", effect.key.indexOf("#")) + 1);

  return card(outcome.isError ? "failed" : effect.replayed ? "replayed" : "live", [
    rowHead(mark(effect), "tool", effect.key, effect.durationMs),
    `<p class="call"><span class="mono">${escape(name)}</span>${
      outcome.isError ? ` <span class="tag failed">error</span>` : ""
    }</p>`,
    request ? `${caption("called with")}${json(request.input)}` : "",
    `${caption(outcome.isError ? "error" : "returned")}<pre class="result">${escape(outcome.content)}</pre>`,
    nested.length > 0 ? `<ul class="reads">${nested.map(readLine).join("")}</ul>` : "",
  ]);
}

/** A clock, uuid or random read that happened outside a tool call. */
function readCard(effect: Effect): string {
  return card(effect.replayed ? "replayed" : "live", [
    rowHead(mark(effect), effect.kind, effect.key, effect.durationMs),
    `<p class="facts">${escape(readValue(effect))}</p>`,
  ]);
}

function readLine(effect: Effect): string {
  const suffix = effect.key.slice(effect.key.indexOf("/") + 1);
  return (
    `<li><span class="kind">${escape(effect.kind)}</span>` +
    `<span class="mono dim">${escape(suffix)}</span>` +
    `<span class="value">${escape(readValue(effect))}</span></li>`
  );
}

function readValue(effect: Effect): string {
  if (effect.kind === "clock" && typeof effect.value === "number") {
    return `${effect.value}  ${isoTime(effect.value)}`;
  }
  return typeof effect.value === "string" ? effect.value : JSON.stringify(effect.value);
}

function chargeLine(charge: Charge, effects: readonly Effect[]): string {
  const model = effects.find((e) => e.kind === "model");
  const free = model?.replayed === true;
  return (
    `<p class="charge">${tokens(charge.usage)}<span class="sep">·</span>` +
    `list ${escape(formatUsd(charge.costUsd))}<span class="sep">·</span>` +
    `billed ${escape(formatUsd(charge.billedUsd))}` +
    (free ? `<span class="tag replayed">replayed, not billed</span>` : "") +
    `</p>`
  );
}

function ending(summary: RunSummary): string {
  const totals = summary.totals;
  return section("ending", [
    `<h2>Ending</h2>`,
    `<p class="meta">${statusPill(summary.status)}${
      totals
        ? `<span>${totals.steps} steps</span><span class="sep">·</span>` +
          `<span>${totals.toolCalls} tool calls</span><span class="sep">·</span>` +
          `<span>list ${escape(formatUsd(totals.costUsd))}</span><span class="sep">·</span>` +
          `<span>billed ${escape(formatUsd(totals.billedUsd))}</span>`
        : `<span>still running, or stopped without a finish event</span>`
    }</p>`,
    summary.error ? `<p class="error">${escape(summary.error)}</p>` : "",
    summary.output
      ? `<div class="output">${paragraphs(summary.output)}</div>`
      : `<p class="note">This run produced no final text.</p>`,
  ]);
}

function colophon(summary: RunSummary, events: readonly RetraceEvent[]): string {
  return (
    `<footer><p>${events.length} events · run started ${escape(isoTime(summary.startedAt))} · ` +
    `<span class="mono">retrace show ${escape(summary.runId)}</span> prints the same timeline in a terminal</p></footer>`
  );
}

// ---------------------------------------------------------------- fragments

function section(name: string, parts: string[]): string {
  return `<section class="${name}">${parts.filter((p) => p !== "").join("")}</section>`;
}

function card(tone: string, parts: string[]): string {
  return `<article class="card ${tone}">${parts.filter((p) => p !== "").join("")}</article>`;
}

function rowHead(marker: string, kind: string, key: string, durationMs: number | undefined): string {
  const timing = durationMs === undefined || durationMs === 0 ? "" : `<span class="ms">${duration(durationMs)}</span>`;
  return (
    `<p class="head">${marker}<span class="kind">${escape(kind)}</span>` +
    `<span class="mono dim">${escape(key)}</span>${timing}</p>`
  );
}

function mark(effect: Effect): string {
  const state = effect.replayed ? badge("replayed", "replayed") : badge("live", "live");
  return state + (effect.overridden ? setBadge() : "") + (effect.stale ? staleBadge() : "");
}

/** Served from the log, but not the value the log recorded. */
function setBadge(): string {
  return (
    `<span class="badge set" title="this value was substituted for the recorded ` +
    `one — what the run saw, not what the parent recorded">set</span>`
  );
}

/**
 * Served from the log, but recorded against a different request than the one
 * this run built. The title carries the explanation so the badge doesn't have
 * to be long enough to be one.
 */
function staleBadge(): string {
  return (
    `<span class="badge stale" title="replayed from a log that recorded this answer ` +
    `against a different request">stale</span>`
  );
}

function badge(label: string, tone: string): string {
  return `<span class="badge ${tone}">${escape(label)}</span>`;
}

function caption(label: string): string {
  return `<p class="cap">${escape(label)}</p>`;
}

function stat(label: string, value: string, tone = ""): string {
  return (
    `<div class="stat ${tone}"><div class="value">${escape(value)}</div>` +
    `<div class="label">${escape(label)}</div></div>`
  );
}

function statusPill(status: string): string {
  const tone =
    status === "completed"
      ? "good"
      : status === "running"
        ? "idle"
        : status === "budget_exceeded" || status === "max_steps"
          ? "warn"
          : "bad";
  return `<span class="status ${tone}">${escape(status.replace("_", " "))}</span>`;
}

function tokens(usage: Usage): string {
  const cache =
    usage.cacheReadTokens + usage.cacheWriteTokens > 0
      ? ` (${count(usage.cacheReadTokens)} cached)`
      : "";
  return `${count(usage.inputTokens)} in${escape(cache)} · ${count(usage.outputTokens)} out`;
}

function count(n: number): string {
  // Grouped by hand: toLocaleString depends on the machine's locale, and this
  // page is supposed to render the same everywhere.
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function json(value: unknown): string {
  return `<pre class="args">${escape(JSON.stringify(value, null, 2) ?? "undefined")}</pre>`;
}

function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -------------------------------------------------------------------- style

/**
 * Warm paper in light, warm ink in dark, and nothing that needs the network.
 * Live effects are rust, replayed effects are green: the two things a reader is
 * actually here to tell apart.
 */
const STYLE = `
:root{color-scheme:light dark;
--paper:#faf6ef;--card:#fffdf8;--ink:#2b2620;--soft:#6d6459;--faint:#9a9083;--rule:#e7ddcc;
--live:#a8500f;--live-bg:#f7e9da;--replayed:#436b4f;--replayed-bg:#e6ede4;--bad:#96291a;--bad-bg:#f6e2de;
--set:#2f5b6e;--set-bg:#e1ebee;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,ui-serif,serif;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{
--paper:#16130f;--card:#1e1a15;--ink:#ece3d5;--soft:#a19685;--faint:#7d7364;--rule:#332c23;
--live:#e2954f;--live-bg:#2c2117;--replayed:#8fb48f;--replayed-bg:#1b241c;--bad:#e07a63;--bad-bg:#2b1b18;
--set:#82b2c4;--set-bg:#172428}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
font-size:16px;line-height:1.55;-webkit-text-size-adjust:100%}
main{max-width:56rem;margin:0 auto;padding:3.5rem 1.25rem 5rem}
h1{font-family:var(--serif);font-size:2.5rem;line-height:1.1;margin:.2rem 0 .6rem;letter-spacing:-.01em;word-break:break-all}
h2{font-family:var(--serif);font-size:1.35rem;font-weight:600;margin:0 0 .25rem}
p{margin:0 0 .5rem}
.eyebrow{font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);margin:0}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem;color:var(--soft);font-size:.9rem}
.sep{color:var(--faint)}
.lineage{color:var(--soft);font-size:.9rem}
.lede{font-family:var(--serif);font-size:1.15rem;font-style:italic;color:var(--ink);
max-width:42rem;margin:1rem 0 1.25rem}
.input{margin:0;padding:.35rem 0 .35rem 1rem;border-left:2px solid var(--rule);
font-family:var(--serif);font-size:1.05rem;color:var(--soft);white-space:pre-wrap}
.masthead{border-bottom:1px solid var(--rule);padding-bottom:1.75rem}
.status{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;padding:.15rem .5rem;
border-radius:2px;border:1px solid currentColor}
.status.good{color:var(--replayed)}.status.warn{color:var(--live)}
.status.bad{color:var(--bad)}.status.idle{color:var(--faint)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:1px;
background:var(--rule);border:1px solid var(--rule);margin:2rem 0}
.stat{background:var(--paper);padding:.85rem .9rem}
.stat .value{font-family:var(--serif);font-size:1.5rem;line-height:1.2}
.stat .label{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:.15rem}
.stat.saved .value{color:var(--replayed)}
.note{color:var(--faint);font-size:.85rem;max-width:40rem}
.timeline{margin-top:2.5rem}
.step{display:grid;grid-template-columns:3rem 1fr;gap:1rem;padding-top:1.5rem}
.ordinal{font-family:var(--serif);font-size:1.6rem;color:var(--faint);text-align:right;
line-height:1;padding-top:.6rem;border-top:1px solid var(--rule)}
.cards{min-width:0;border-top:1px solid var(--rule);padding-top:.75rem}
.card{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--faint);
padding:.7rem .85rem;margin-bottom:.6rem}
.card.live{border-left-color:var(--live)}
.card.replayed{border-left-color:var(--replayed)}
.card.failed{border-left-color:var(--bad)}
.card.unrun{border-left-style:dashed}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;margin:0}
.badge{font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;padding:.1rem .35rem;border-radius:2px}
.badge.live{color:var(--live);background:var(--live-bg)}
.badge.replayed{color:var(--replayed);background:var(--replayed-bg)}
.badge.unrun{color:var(--bad);background:var(--bad-bg)}
.badge.stale{color:var(--soft);border:1px dashed var(--rule);padding:0 .3rem}
.badge.set{color:var(--set);background:var(--set-bg)}
.tag{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--soft)}
.tag.failed{color:var(--bad)}
.kind{font-size:.8rem;color:var(--soft)}
.mono{font-family:var(--mono);font-size:.78rem;word-break:break-all}
.dim{color:var(--faint)}
.ms{margin-left:auto;font-size:.75rem;color:var(--faint);font-variant-numeric:tabular-nums}
.facts{font-size:.8rem;color:var(--soft);margin:.35rem 0 0;display:flex;flex-wrap:wrap;
align-items:baseline;gap:.4rem}
.call{margin:.4rem 0 .3rem;font-size:.9rem}
.cap{font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
margin:.55rem 0 -.2rem}
pre{font-family:var(--mono);font-size:.78rem;line-height:1.45;margin:.4rem 0 0;
padding:.55rem .7rem;background:var(--paper);border:1px solid var(--rule);
white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:22rem}
pre.args{color:var(--soft)}
.says{font-family:var(--serif);font-size:1.05rem;margin-top:.5rem}
.says p{margin:0 0 .5rem}
.thinking summary{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
cursor:pointer;margin-top:.5rem}
.reads{list-style:none;margin:.5rem 0 0;padding:.4rem 0 0;border-top:1px dotted var(--rule)}
.reads li{display:flex;flex-wrap:wrap;gap:.5rem;font-size:.78rem;color:var(--soft);padding:.1rem 0}
.reads .value{font-family:var(--mono);color:var(--ink)}
.charge{font-size:.75rem;color:var(--faint);display:flex;flex-wrap:wrap;gap:.4rem;
align-items:baseline;margin:.25rem 0 0;font-variant-numeric:tabular-nums}
.ending{margin-top:3rem;border-top:1px solid var(--rule);padding-top:1.5rem}
.output{font-family:var(--serif);font-size:1.15rem;margin-top:.75rem;max-width:42rem}
.error{color:var(--bad);font-size:.9rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);
font-size:.75rem;color:var(--faint)}
@media (max-width:34rem){.step{grid-template-columns:1fr;gap:0}
.ordinal{text-align:left;border-top:none;padding-top:1rem}.cards{border-top:none}}
@media print{body{background:#fff}.card{break-inside:avoid}pre{max-height:none}}
`;
