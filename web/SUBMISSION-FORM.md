# BuilderBase submission — copy/paste answers

**Live product link:** https://ax-route.vercel.app
**Pitch slides (public, incognito-safe):** https://ax-route.vercel.app/deck.html
**Code:** https://github.com/lpsmurf/ax-route

---

## What did you build, and what problem does it solve?

Teams running coding agents are billed at frontier prices for work that is not hard. Most agent
calls are mechanical — fetch this file, pull the number out of that text, check whether the JSON
parses, did the test pass. They are a large and growing share of every agent workload, because
agents take more steps per task every month. Nothing routes them anywhere cheaper.

I am the user, and I have the invoice. Over 104 days my agent tools billed **$1,240.47**. In the
local transcripts there are **3,865 real requests**; `claude-opus-5` served **65.5%** of them.
My own harness declares that three of its eight agent roles should run on the cheap tier. Across
those 3,865 requests the cheap tier ran **five — 0.13%**. The policy was right and completely
unenforced. That is the problem in one number: a tier policy nothing enforces is a comment, not
a control.

What people do today is nothing, or they hand-edit a model name in a config and hope. There is no
per-job routing, no record of what each call cost, and no way to answer "could that have run
somewhere cheaper" after the fact.

**Route** is an OpenAI-compatible endpoint that sits in front of the models. Every call declares a
job; a policy file a human can read sends it to the cheapest model that can actually do that job —
open weights on Nebius Token Factory for the mechanical majority, a frontier model reserved for
review. Every decision appends a line to a ledger: job, tier, model, tokens, cost, latency,
region. The saving is a receipt, not a claim.

Would they pay? Model spend is becoming a top-three engineering line item, and Route's saving on
measured data is 24–73% of the agent bill depending on how much of the work is mechanical. It is
infrastructure in the request path: the more a team uses agents, the more it returns, and the
switching cost is a policy file they have already tuned. The European angle is the part a US
competitor cannot copy — Nebius serves from Finland, so Route offers "your code never leaves the
EU, and it costs a fraction" to companies contractually barred from sending source to a US
frontier API. That is a compliance requirement and a budget line closed by one product.

---

## Models and Token Factory use

Token Factory is the engine, not an accessory. Every call Route actually makes in production goes
to it.

**In the product path:**
- **`Qwen/Qwen3-30B-A3B-Instruct-2507`** — the *mechanical* tier. Retrieval, extraction and
  mechanical QA: the three job types that dominate agent traffic. This is the model that serves
  the majority of real calls.
- **`Qwen/Qwen3-235B-A22B-Instruct-2507`** — the *reasoning* tier. Investigation, research and
  implementation jobs, and the documented default for any job not named in the policy, so an
  unknown job is never silently downgraded to the cheapest model or silently escalated to a
  frontier one.

**In the measurement path:**
- **`deepseek-ai/DeepSeek-V4-Pro`** — two roles. It is the strong baseline in the head-to-head,
  and it is the **judge**: it grades both arms against each fixture's rubric, blind to which model
  produced the answer.
- **19 Token Factory text models swept end to end** to derive the policy rather than assert it:
  Qwen3-30B, Qwen3-235B, Qwen3.5-397B, gpt-oss-120b, GLM-5.3, GLM-5.3-Flash, DeepSeek-V4-Pro,
  DeepSeek-V4-Flash, DeepSeek-V4.1-Flash, Kimi-K3, Kimi-K2.6, Kimi-K2.7-Code, Hermes-4-405B,
  Nemotron-3-Nano, Nemotron-3.5-Lightning, Nemotron-3-Super, Nemotron-3-Ultra, MiniMax-M3,
  gemma-3-27b. Embedding and vision models were excluded as they cannot do these jobs.

**Why more than one:** different jobs have different costs of being wrong. Routing everything to
the cheapest model would be a worse product than routing nothing — the point is a declared tier
per job, with the assignment derived from measurement.

**Closed models:** none were called. `claude-opus-5` is named in `policy.yaml` for the critical
tier (code review) but was never invoked — no key was available, so that path is configured and
untested, and the frontier cost comparison is arithmetic over real token counts, labelled
*computed* everywhere it appears rather than presented as an experiment.

Model IDs and prices were read from the Token Factory API itself
(`GET /v1/models?verbose=true`), not from third-party aggregators.

---

## Measurable model advantage

**Proof:** https://ax-route.vercel.app — every figure on the page names the file it came from.
Raw data: [bench.json](https://ax-route.vercel.app/bench.json),
[sweep.json](https://ax-route.vercel.app/sweep.json),
[replay.json](https://ax-route.vercel.app/replay.json). Reproduce with `route bench`,
`route sweep`, `route replay`.

**Baseline 1 — a much larger open model, measured.** 20 fixtures across the three mechanical job
types, two scorers (deterministic exact match, plus the blind judge):

| arm | model | exact match | judge pass | p50 latency | cost |
|---|---|---|---|---|---|
| routed | Qwen3-30B-A3B | 90% | 95% | 998 ms | **$0.000146** |
| strong | DeepSeek-V4-Pro | 85% | 90% | 993 ms | $0.002013 |

**13.8× cheaper, indistinguishable quality, same latency.** At n=20 the 5-point gap is one
question; the claim is that the small model is *not worse*, not that it is better.

**Baseline 2 — the whole catalogue, measured.** All 19 models, same fixtures, same judge.
Quality landed between **85% and 100%**. Price across the same 19 spanned **355×**. The cheapest
model clearing a 90% bar is Qwen3-30B at **$0.0073 per 1,000 tasks**; Kimi-K3 scores the same 95%
at **$2.5909 per 1,000 tasks**. On mechanical work, price predicts almost nothing about quality.

**Baseline 3 — frontier list price, computed.** The same measured token counts priced at
published rates: 12× vs claude-haiku-4-5, 25× vs claude-sonnet-5, **62× vs claude-opus-5**, 123×
vs gpt-6-astra. Arithmetic, not an experiment, and labelled as such.

**Baseline 4 — my own historical spend, measured.** 3,865 real requests over 50 days re-priced
from raw token counts: $164.40 actual. Routing 50% of it to Token Factory takes it to $83.98, a
**48.9% saving**. Reported as a 25/50/75% band because the mechanical share is an assumption, not
a measurement.

**A methodology note I am volunteering:** the first sweep capped output at 300 tokens and scored
reasoning models as incapable when they truncated mid-scratchpad — Qwen3.5-397B read 20%. The
ceiling was raised to 1,200 and it reads 85%. Its scratchpad tokens are still billed and still
counted against its cost, which is why it remains expensive per task. Cheap per token is not the
same as cheap per task, which is why every number here is cost per task.

---

## Responsible design

Routing is **declared, never inferred**: the caller names the job and a human-readable
`policy.yaml` decides the model, so no second model guesses intent and nothing is silently
promoted to a pricier tier or silently downgraded to a cheaper one. Every call appends an
auditable ledger line (job, model, tokens, cost, latency, region), so if the model gets something
wrong the user can see exactly which model answered, what it cost, and pin that job to a higher
tier in one line.

On privacy: the replay reads local agent transcripts but emits **aggregates only** — counts,
tokens and dollars. Project names, file paths and prompt text never reach the published output,
because several are client names. API keys are read from environment or the macOS Keychain and
never written to the repository, which gitleaks gates on every commit. Open weights run in the EU
(Finland), so source code never leaves EU jurisdiction. And no number is invented: a model with
no published price reports `null` rather than an estimate, and every figure is labelled
*measured* or *computed* on the dashboard and in the README.

---

## Pitch slides

https://ax-route.vercel.app/deck.html

11 slides, arrow keys or click, `F` for fullscreen. Covers all six criteria:
product and user value (2–3), problem and company potential (2, 3, 10), measurable model
advantage (6, 7, 8, 9), technical execution and Token Factory use (5, 6), demo clarity (5 is the
live demo cue), responsible design (8, 11).
