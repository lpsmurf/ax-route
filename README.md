<h1 align="center">Route</h1>
<p align="center"><strong>A cost governor for agent workloads.</strong></p>
<p align="center">
  <a href="https://ax-route.vercel.app">Live results</a> ·
  Built at <a href="https://builderbase.com/event/accel-ai-innovate-amsterdam">Accel AI Innovate Amsterdam</a>, 23 September 2026
</p>

---

## Who this is for

People who build with AI all day and are not infrastructure engineers. They have one setting they
understand — pick the best model — so they pick it for everything, including "does this file
parse". They will never hand-tune a routing table, so it has to be measured for them.

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

**Step one is an audit, and it needs no API key.** Route reads the usage logs your agent tools
already keep on disk — every project, every request, which model ran it, and how you pay for it —
then says which of that work can move to open weights *on measured evidence*:

```
$ npx ax-route audit
sources: claude-code 5538 · codex 2564 · kimi 365 · hermes 68 · openclaw 215
usage:   10,489 requests across 139 projects

tool         billing          reqs   tokens      paid  api-equiv  unpriced
claude-code  subscription     5538     1.3B     $0.00    $985.49         -
codex        subscription     2564   263.2M     $0.00    $143.07     16.4M
hermes       subscription     1807   154.3M     $0.00    $103.75         -
kimi         subscription      365    40.6M     $0.00      $6.84     26.8M

subscriptions — flat fee, $0 per token:
  codex        tier plus · worth $246.82 at API prices over 74 days · fee $49.33 → 5x value (used by codex, hermes)
               limits as of 2026-09-22: 5h 10% (peak 99%) · 7d 31% (peak 75%)

routes: 3 of 8 roles deployable on measured evidence, 5 untested
overspend today (pay-per-token):        $0.00
offloadable (subscriptions, API prices): $462.24  — frees plan limits, not cash
```

Three of eight roles have fixtures behind them and are marked deployable. The other five do not,
so Route will not call them safe. A routing tool that marked all eight green would be guessing on
five of them.

### Which tools it reads

| Tool | Reads | Billing detected from |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | signed-in account type in `~/.claude.json` |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` | ChatGPT plan in the rate-limit events; also reports 5-hour and weekly limit use |
| **Kimi Code** | `~/.kimi-code/sessions` (2.x) and `~/.kimi/sessions` (1.x) | `kimi-code/` models are the membership plan |
| **Hermes** | `~/.hermes/state.db` (needs Node 22.5+) | Hermes' own per-model billing record |
| **OpenClaw** | `~/.openclaw/agents/*/sessions/*.jsonl` | the provider endpoint in `openclaw.json` |
| **Cursor** | detected only | usage lives on Cursor's servers — reader not built yet |

**Two kinds of money, never mixed.** Pay-per-token usage is real spend and can be overspent.
A flat subscription costs nothing per token, so its usage is shown at *API-equivalent* value and
against the plan's rate limits — moving mechanical work off it frees limits, not cash. Hermes and
OpenClaw are model-agnostic; when they run on your Codex or Kimi plan, that usage counts against
that plan, once.

```
route audit --plan codex=20,claude-code=200   # your monthly fees → value multiple per plan
route audit --billing openclaw=api            # correct a tool's billing when detection can't tell
route audit --source codex,kimi               # only read these tools
route audit --reveal                          # real project names instead of stable labels
```

**Step two is enforcement.** One OpenAI-compatible endpoint. Every call declares a *job*. A policy file a human can read maps
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

### The routing choice, measured — the sweep

A routing policy should be derived, not asserted. All **19 text models on Token
Factory** ran the same 20 fixtures and were scored identically, with the judge blind
to which model answered.

Quality landed between **85% and 100%**.
Price across the same models spread **355×**.

| model | judge pass | exact match | $ / 1k tasks | p50 |
|---|---|---|---|---|
| **Qwen/Qwen3-30B-A3B-Instruct-2507** | 95% | 90% | $0.0073 | 389 ms |
| google/gemma-3-27b-it | 90% | 80% | $0.0078 | 298 ms |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 95% | 95% | $0.0145 | 541 ms |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 95% | 90% | $0.0296 | 1284 ms |
| nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | 95% | 90% | $0.0315 | 1513 ms |
| openai/gpt-oss-120b | 95% | 95% | $0.0762 | 574 ms |
| zai-org/GLM-5.3-Flash | 100% | 90% | $0.0832 | 2113 ms |
| NousResearch/Hermes-4-405B | 95% | 90% | $0.0863 | 461 ms |
| nvidia/Nemotron-3_5-Lightning | 95% | 90% | $0.0885 | 3235 ms |
| nvidia/nemotron-3-super-120b-a12b | 95% | 95% | $0.0895 | 1241 ms |
| deepseek-ai/DeepSeek-V4-Pro | 95% | 95% | $0.1004 | 1089 ms |
| deepseek-ai/DeepSeek-V4.1-Flash | 95% | 95% | $0.1038 | 1509 ms |
| MiniMaxAI/MiniMax-M3 | 95% | 95% | $0.1492 | 940 ms |
| moonshotai/Kimi-K2.7-Code | 95% | 95% | $0.3198 | 3758 ms |
| nvidia/Nemotron-3-Ultra-550b-a55b | 90% | 90% | $0.3795 | 1184 ms |
| zai-org/GLM-5.3 | 100% | 90% | $0.7633 | 1366 ms |
| moonshotai/Kimi-K2.6 | 95% | 90% | $0.7922 | 1646 ms |
| Qwen/Qwen3.5-397B-A17B | 85% | 90% | $2.0168 | 3388 ms |
| moonshotai/Kimi-K3 | 95% | 90% | $2.5909 | 1292 ms |

**The cloud is flat.** On mechanical work, price predicts almost nothing about quality.
`Qwen/Qwen3-30B-A3B-Instruct-2507` clears the bar at **$0.0073 per 1,000 tasks**;
`moonshotai/Kimi-K3` scores the same 95% at **$2.5909** —
355× the price for no measurable gain. That is why `policy.yaml` names the model it does.

A first pass capped output at 300 tokens and scored reasoning models as incapable when they
truncated mid-scratchpad — `Qwen3.5-397B` read 20%. The ceiling was raised to
1200 and it reads 85%.
The scratchpad tokens are still billed and still counted against its cost, which is why it sits
where it does on price. Reproduce with `route sweep`.

### The same tokens at frontier list price — computed

Arithmetic over the measured token counts, no frontier calls made:

| model | cost for the same 20 tasks | vs routed |
|---|---|---|
| claude-haiku-4-5 | $0.001802 | 12× |
| claude-sonnet-5 | $0.003604 | 25× |
| claude-opus-5 | $0.009010 | **62×** |
| gpt-6-astra | $0.018020 | 123× |

### Replay of real work — measured

3,985 deduped requests over 50 days, priced from raw token counts:
**$664.87**.

| mechanical share routed | bill becomes | saved |
|---|---|---|
| 25% | $528.43 | $136.45 (20.5%) |
| 50% | $391.98 | $272.89 (41%) |
| 75% | $255.53 | $409.34 (61.6%) |

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

## Built for both ends

| | |
|---|---|
| **Day one** | `npx ax-route audit`. No API key, no signup, no config. Reads Claude Code, Codex, Kimi Code, Hermes and OpenClaw logs, prints what you spend or what your plan is worth, and what can move. |
| **Day one hundred** | A policy file in version control, model sweeps against your own fixtures, per-project ledgers, and JSON output you can diff or gate CI on. |

The audit is the on-ramp because it costs nothing to run and answers the only question a new user
has: *is there money here at all?*

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
| `src/estate.mjs` | The audit. Merges every source, splits paid from API-equivalent, groups subscriptions by plan. |
| `src/sources/*.mjs` | One reader per agent tool, all returning the same usage record. Add a tool by adding a file. |

## What is not built

Named honestly, because a demo that overstates its reach is worth less than one that does not:

- **Claude Code routing.** The audit reads Claude Code; the endpoint cannot route it yet. Route
  speaks the OpenAI wire format, which Token Factory, Codex, Cursor, Continue and the OpenAI SDK
  all speak. Claude Code speaks the Anthropic format; that adapter is the next piece of work.
- **A Cursor audit.** Cursor keeps per-request usage on its servers, not on disk, so the audit
  detects Cursor and says so instead of reporting zero.
- **Quality-gate escalation.** The design escalates a failed job to the next tier up. Today the
  policy is static and the benchmark measures the failure rate that would trigger it.
- **Streaming responses.**
- **A frontier arm in the benchmark.** No frontier key was available during the build, so the
  strong arm is the largest open model on Token Factory and the frontier comparison is arithmetic
  over measured tokens. Labelled computed wherever it appears.

## A correction, on the record

An earlier version of this repository reported the replay at **$164.40**. That was wrong and the
real figure is **$664.87**. `cost()` subtracted cached tokens from the input count before pricing
them, and because the caller passes non-cached input, the cache term cancelled to zero — every
cached token was billed at nothing. On real Claude Code traffic cache reads outnumber fresh input
by roughly fifty to one, so the error hid about three quarters of the bill.

It surfaced while writing a benchmark fixture that asks a model to spot exactly that bug
(`r15` in `bench/fixtures/mechanical.json`). Fixing it made the problem this project describes
four times larger. Cache rates are now explicit per model in `prices.yaml` rather than defaulted,
and the OpenAI-wire call sites split `prompt_tokens` from `cached_tokens` so neither is counted
twice.

## Lineage

Route is the enforcement half of a policy that already existed as documentation in
[ax-harness](https://github.com/lpsmurf/ax-harness) — where `config/models.yaml` has declared a
cheapest-capable tier per subagent since day one, and
`.specify/specs/001-ax-harness/tasks.md` has carried `T304 pricing + ROI calc` unchecked. This is
T304, built.

MIT.
