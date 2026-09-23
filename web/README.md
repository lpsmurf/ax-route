<h1 align="center">Route</h1>
<p align="center"><strong>A cost governor for agent workloads.</strong></p>
<p align="center">
  <a href="https://ax-route.vercel.app">Live results</a> ·
  Built at <a href="https://builderbase.com/event/accel-ai-innovate-amsterdam">Accel AI Innovate Amsterdam</a>, 23 September 2026
</p>

---

## The problem, measured

One operator, 20+ projects, two Macs. Over 104 days the agent tools billed **$1,240.47**
— claude $1,088.61, codex $145.02, kimi $6.84.

The harness that runs those agents declares a cheapest-capable model tier for each of its eight
subagent roles: retrieval and extraction on the cheap tier, implementation in the middle, review
on the expensive one. It is a good policy. Nothing parses it.

Across **3,865 real requests** in the local transcripts, the cheap tier ran **5 of them — 0.13%**.
`claude-opus-5` ran 65.5%.

> A tier policy that nothing enforces is a comment, not a control.

## What Route does

One OpenAI-compatible endpoint. Every call declares a *job*. A policy file a human can read maps
that job to the cheapest model that can actually do it — open weights on **Nebius Token Factory**
for the mechanical majority, a frontier model only where being wrong is expensive. Every decision
lands in an append-only ledger with its tokens, its price and its latency.

```
POST /v1/chat/completions
x-route-job: memory-retrieval
  → tier mechanical → Qwen/Qwen3-30B-A3B-Instruct-2507   (Nebius, EU Finland)

x-route-job: code-review
  → tier critical   → claude-opus-5                       (frontier)
```

The response body is passed through untouched, so any OpenAI client works unmodified.

## The evidence

### Head-to-head — measured

20 fixtures across the three mechanical job types, both arms scored twice: deterministic exact
match, and an LLM judge grading against each rubric **blind to which arm produced the answer**.

| arm | model | exact match | judge pass | p50 | cost |
|---|---|---|---|---|---|
| **routed** | `Qwen/Qwen3-30B-A3B-Instruct-2507` | **90%** | **95%** | 998 ms | **$0.000146** |
| strong | `deepseek-ai/DeepSeek-V4-Pro` | 85% | 90% | 993 ms | $0.002013 |

**13.8× cheaper at indistinguishable quality.** At n=20 the 5-point quality gap is noise — the
honest claim is that the small model is not worse, not that it is better. Both arms failed the
same three fixtures on exact match and passed them on the judge: open-ended items where substring
matching is too strict. That disagreement is a scorer artifact, not a model difference.

### The same tokens at frontier list price — computed

Arithmetic over the measured token counts, no frontier calls made:

| model | cost for the same 20 tasks | vs routed |
|---|---|---|
| claude-haiku-4-5 | $0.001802 | 12× |
| claude-sonnet-5 | $0.003604 | 25× |
| claude-opus-5 | $0.009010 | **62×** |
| gpt-6-astra | $0.018020 | 123× |

### Replay of real work — measured

3,865 deduped requests over 50 days, priced from raw token counts: **$164.40**.

| mechanical share routed | bill becomes | saved |
|---|---|---|
| 25% | $124.19 | $40.21 (24.5%) |
| 50% | $83.98 | $80.42 (48.9%) |
| 75% | $43.77 | $120.63 (73.4%) |

A scenario, not a measurement — and labelled that way on the dashboard. Independent support for
the low end: the harness's own accounting already carried a `cheaperShare: 0.3` estimate before
Route existed.

## Why this is only possible now

Open weights crossed the line for mechanical work this year, and Token Factory puts 24 of them
behind one endpoint at a published per-token price you can compute against. In 2024 the cheap
tier could not do the job at all. The routing decision had no upside, so nobody built the
governor. Now the gap is 62× and the quality difference is noise.

## Responsible design

- **Routing is declared, never inferred.** The caller names the job; `policy.yaml` decides. No
  second model call guessing intent, no silent promotion to a more expensive tier.
- **Every call is auditable.** One append-only ledger line per decision.
- **No invented numbers.** A model with no published price reports `cost: null`. Never an
  estimate, never interpolated from a similar model. Prices come from the Token Factory API
  itself (`GET /v1/models?verbose=true`), not from aggregators.
- **Measured and computed are labelled differently**, in the README and on the dashboard.
- **EU data residency.** Nebius serves from Finland, so code never leaves the EU — the wedge for
  European companies contractually unable to send source to US frontier APIs.
- **Aggregates only.** The replay reads local transcripts and emits counts, tokens and dollars.
  Project names, paths and prompt text never reach the committed output.

## Install

```bash
git clone https://github.com/lpsmurf/ax-route && cd ax-route
security add-generic-password -a "$USER" -s NEBIUS_API_KEY -w   # or export NEBIUS_API_KEY
node bin/route serve
```

Node 20+. **No dependencies** — Node built-ins only, no `npm install`, no bundler, no database.

```bash
route serve [--port 8787]   # OpenAI-compatible endpoint that routes by job
route policy                # show the routing table
route bench [--n 20]        # head-to-head against a stronger model
route replay                # re-price real historical usage under the policy
```

Point any OpenAI client at `http://localhost:8787/v1` and set `x-route-job`.

## Architecture

| File | Responsibility |
|---|---|
| `policy.yaml` | Job → tier → model. The single source of routing truth. |
| `prices.yaml` | $/1M in and out per model, each entry naming its source and confidence. |
| `src/policy.mjs` | Parse the policy; resolve a job to a decision. Keys from env or macOS Keychain. |
| `src/price.mjs` | Longest-prefix price lookup so dated model ids resolve. Returns null when unpriced. |
| `src/proxy.mjs` | The endpoint. Resolve, forward, pass through, record. |
| `src/ledger.mjs` | Append-only JSONL. One line per routed call. |
| `src/bench.mjs` | Two arms, two scorers, blind judge. |
| `src/replay.mjs` | Real transcripts → actual cost → counterfactual band. |

## What is not built

Named honestly, because a demo that overstates its reach is worth less than one that does not:

- **Claude Code support.** Route speaks the OpenAI wire format, which Token Factory, Codex,
  Cursor, Continue and the OpenAI SDK all speak. Claude Code speaks the Anthropic format; that
  adapter is the next piece of work, not a thing that exists today.
- **Quality-gate escalation.** The design escalates a failed job to the next tier up. Today the
  policy is static and the benchmark measures the failure rate that would trigger it.
- **Streaming responses.**
- **A frontier arm in the benchmark.** No frontier key was available during the build, so the
  strong arm is the largest open model on Token Factory and the frontier comparison is arithmetic
  over measured tokens. Labelled computed wherever it appears.

## Lineage

Route is the enforcement half of a policy that already existed as documentation in
[ax-harness](https://github.com/lpsmurf/ax-harness) — where `config/models.yaml` has declared a
cheapest-capable tier per subagent since day one, and
`.specify/specs/001-ax-harness/tasks.md` has carried `T304 pricing + ROI calc` unchecked. This is
T304, built.

MIT.
