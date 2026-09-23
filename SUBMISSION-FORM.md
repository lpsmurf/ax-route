# BuilderBase submission — copy/paste answers

**Live product link:** https://ax-route.vercel.app
**Pitch slides (public, incognito-safe):** https://ax-route.vercel.app/deck.html
**Code:** https://github.com/lpsmurf/ax-route

---

## What did you build, and what problem does it solve?

People who build with AI all day and are not infrastructure engineers — vibecoders, solo
founders, designers shipping products, heavy Claude Code and Cursor users — have exactly one
setting they understand: pick the best model. So they pick it for everything, including "does
this file parse". They hit this on every single request, every day. They are doing nothing about
it, because nobody has ever told them which of their jobs don't need the expensive model, and
they are never going to hand-tune a routing table.

I am that user, and I have the receipts. Over 50 days my agent tools billed $664.87 across 4,005
requests and 56 projects. claude-opus-5 served 65.5% of them. My own config file already said
that three of my eight agent jobs should run on the cheap tier — the cheap tier ran five
requests. 0.13%. The policy was right and completely unenforced.

Route reads your machine and tells you what to change. One command, no API key, no account:
it finds every agent role, every project and every request you have already paid for, prices
them, and reports how much can move to a cheaper model — $275.35 of my $670.73 — then names the
specific files to edit. It only recommends jobs it has actually tested: 3 of my 8 are marked
deployable, 5 are marked untested, because a tool that marked all eight green would be guessing
on five and you would find out the expensive way.

The measurement is the product, and it is brutal about its own recommendations. On 21 realistic
tasks — real stack traces, config, source — graded by a blind judge, google/gemma-3-27b-it on
Nebius Token Factory scored 95.2%, exactly what claude-opus-5 scored, at 159x lower cost and 7x
the speed. That same measurement overruled me: the model I had picked by hand failed the bar and
the sweep replaced it.

Would they pay? They already are — just to the wrong place. We charge a share of the savings we
prove, so it comes out of money that was going to burn anyway. This becomes a company because it
sits in the request path of a cost line that is growing faster than headcount, the audit is free
and produces a number people post, and Nebius serves from Finland — so the same product answers
the question every European company is about to be asked about where its source code goes.

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

**Closed models:** yes, and measured — claude-haiku-4-5, claude-sonnet-5 and claude-opus-5 were
called directly over the Anthropic API as the comparison baseline, at a total cost of $0.0683. They
are the baseline, not part of the product path. Previously: none were called. `claude-opus-5` is named in `policy.yaml` for the critical
tier (code review) but was never invoked — no key was available, so that path is configured and
untested, and the frontier cost comparison is arithmetic over real token counts, labelled
*computed* everywhere it appears rather than presented as an experiment.

Model IDs and prices were read from the Token Factory API itself
(`GET /v1/models?verbose=true`), not from third-party aggregators.

---

## Measurable model advantage

**Proof:** https://ax-route.vercel.app — every figure names the file it came from and is marked
measured or computed. Raw: [frontier.json](https://ax-route.vercel.app/frontier.json),
[sweep.json](https://ax-route.vercel.app/sweep.json),
[bench.json](https://ax-route.vercel.app/bench.json),
[escalate.json](https://ax-route.vercel.app/escalate.json),
[replay.json](https://ax-route.vercel.app/replay.json).
Reproduce with `route frontier`, `route sweep`, `route bench`, `route escalate`, `route replay`.

**The headline, fully measured.** Same 21 realistic tasks — real stack traces, YAML config,
source files, git history, raw usage records — one blind judge, no arithmetic:

| model | judge pass | cost, 21 tasks | p50 |
|---|---|---|---|
| **google/gemma-3-27b-it** (open, Nebius) | **95.2%** | **$0.000319** | 378 ms |
| claude-haiku-4-5 (Anthropic) | 90.5% | $0.003697 | 814 ms |
| claude-sonnet-5 (Anthropic) | 81% | $0.013938 | 1693 ms |
| claude-opus-5 (Anthropic) | 95.2% | $0.050645 | 2564 ms |

**An open model on Token Factory matched claude-opus-5 exactly — 95.2% against
95.2% — at 159× lower cost and 7× the speed.** Whole Anthropic run cost $0.0683.

**The catalogue sweep.** All 19 Token Factory text models on the same tasks:
accuracy spans **66.7–95.2%**, price spans **172×**. The most expensive model tested
scored the *worst* of all 19. Paying more buys nothing here.

**The tool overruled its author.** `policy.yaml` previously named Qwen3-30B, which I chose by
hand. When the fixtures were rewritten from toy questions to real ones it fell to
76.2% and failed the 90% bar. The sweep
replaced it with google/gemma-3-27b-it. That is the assessment layer doing its job, in public, against me.

**Two negative results, both published.** Automatic escalation does not work: a gate asking the
cheap model whether its own answer looked complete escalated 1 task in 21 and changed nothing;
escalating on self-disagreement escalated 19% and still scored
81%, the same as the cheap model alone, at
4.8× the cost. A cheap general-purpose confidence
gate cannot see wrongness, because a small model is wrong confidently and in good form.

**A correction we found ourselves.** The replay first reported $164.40. `cost()` subtracted
cached tokens from an input count that already excluded them, so every cached token billed at
zero — and cache reads outnumber fresh input roughly fifty to one. The real figure is
**$664.87**. It surfaced while writing a fixture that asks a model to spot
exactly that bug. Fixing it made the problem four times larger.

**Replay.** 3,985 real requests over 50 days re-priced from raw
tokens: $664.87. Routing half of it takes the bill to
$391.98, a 41% saving.
Presented as a 25/50/75 band because the mechanical share is an assumption, not a measurement.

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
