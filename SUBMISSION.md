# Route — submission

**Accel AI Innovate: Amsterdam, 23 September 2026**
Live: https://ax-route.vercel.app · Code: https://github.com/lpsmurf/ax-route

---

## 1. Working product

`route` — an OpenAI-compatible endpoint that routes every agent call to the cheapest model that
can do that job, and leaves a costed receipt for each decision. Node 20, zero dependencies,
installs in one clone.

```bash
node bin/route serve
curl -X POST localhost:8787/v1/chat/completions \
  -H 'x-route-job: memory-retrieval' \
  -d '{"messages":[{"role":"user","content":"..."}]}'
# → Qwen/Qwen3-30B-A3B-Instruct-2507 on Nebius Token Factory, one ledger line, real cost
```

## 2. Named customer and the problem

**Luis** — one operator, 20+ projects, two Macs, eight agent roles. Not a persona: the bill is in
the repo.

- **$1,240.47** of measured agent spend over 104 days across three tools.
- **3,865 real requests** in the local transcripts. `claude-opus-5` ran **65.5%** of them.
- The harness declares three of its eight job types as cheap-tier work. The cheap tier actually
  ran **5 requests — 0.13%**.

The problem is not that the policy is wrong. It is that nothing enforces it, so mechanical work
— retrieval, extraction, mechanical QA — is billed at frontier prices by default.

## 3. Model and Token Factory architecture

Token Factory is the engine, not an accessory: every mechanical and reasoning call in the system
runs on it, and the frontier model is the exception reserved for review.

```
client (any OpenAI SDK)
   │  POST /v1/chat/completions   x-route-job: <job>
   ▼
route proxy ── policy.yaml ──▶ tier ──▶ model
   │                            mechanical → Qwen/Qwen3-30B-A3B-Instruct-2507  ┐
   │                            reasoning  → Qwen/Qwen3-235B-A22B-Instruct-2507├─ Nebius
   │                            critical   → claude-opus-5                     ┘   Token Factory
   ├──▶ Nebius Token Factory  (api.studio.nebius.com/v1, EU Finland)              (EU Finland)
   └──▶ ledger/*.jsonl  {job, tier, model, tokens, cost_usd, latency_ms, outcome}
```

Model ids and prices are read from the Token Factory API itself
(`GET /v1/models?verbose=true`, authenticated) — 24 models, primary source, not aggregators.

## 4. Evidence of the advantage

**Measured.** 20 fixtures across the three mechanical job types, two arms, two scorers, judge
blind to arm:

| arm | model | exact match | judge pass | p50 | cost |
|---|---|---|---|---|---|
| **routed** | Qwen3-30B-A3B | **90%** | **95%** | 998 ms | **$0.000146** |
| strong | DeepSeek-V4-Pro | 85% | 90% | 993 ms | $0.002013 |

**13.8× cheaper at indistinguishable quality.** At n=20 the quality gap is noise; the claim is
that the cheap model is *not worse*, not that it is better.

**Computed.** The same measured token counts at frontier list price: **62× vs claude-opus-5**,
25× vs sonnet-5, 12× vs haiku-4-5.

**Replay.** 3,865 real requests over 50 days re-priced from raw tokens: $164.40 actual. Routing
50% of it to Token Factory takes it to $83.98 — a 48.9% saving. Presented as a band (25/50/75%)
and labelled a scenario, because the mechanical share is an assumption, not a measurement.

Reproduce: `route bench` and `route replay`. Both write JSON the dashboard reads; every figure on
screen names its source file.

## 5. Business case

The wedge is cost; the moat is residency.

Agent spend is becoming a top-three line item for engineering teams, and the mechanical share of
it is large and growing as agents take on more steps per task. Route sits in the request path as
infrastructure — the more an org uses agents, the more it saves, and the switching cost is a
policy file it has already tuned.

The European angle is the part competitors cannot copy from the US: Nebius serves from Finland,
so Route can offer "your code never leaves the EU, and it costs 62× less" to companies that are
contractually unable to send source to a US frontier API. That is a compliance requirement and a
budget line solved by the same product.

Route is open source. The commercial shape is the hosted control plane: shared policies, spend
limits, team ledgers, and the escalation gate.

## 6. Live demo

1. `route policy` — the routing table, eight jobs, three tiers.
2. `route serve`, then one curl with `x-route-job: memory-retrieval` — a real Token Factory
   response, and the ledger line it just wrote with its real cost.
3. `route bench` — 20 fixtures, two arms, live, ~25 seconds.
4. https://ax-route.vercel.app — the result, with every number citing its file.

## Responsible design

Routing is declared, never inferred. Every call is auditable. Unpriced models report `null`
rather than an estimate. Measured and computed figures are visually distinguished on the
dashboard and in every table above. The replay emits aggregates only — no project names, paths
or prompt text. Keys are read from env or macOS Keychain and never written to the repo.

## Stated limitations

No frontier arm was measured (no key available during the build), so the frontier comparison is
arithmetic over real token counts and is labelled computed. n=20 on the benchmark. Fixtures are
hand-authored against real repo content, not sampled from production — the replay supplies the
real distribution, the fixtures supply the quality test. Claude Code is not yet supported; it
speaks the Anthropic wire format and that adapter is next.
