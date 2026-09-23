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

Token Factory is the engine, not a garnish: every call Route makes in its product path goes to
it, and the only closed models we touched were the baseline we measured against.

IN THE PRODUCT PATH

• google/gemma-3-27b-it — the "simple" tier, and the model that serves the majority of real
  traffic. Extraction (pull a fact or a figure out of a stack trace, a config file or a long
  answer), retrieval (find the value in a file), and classification-style checks (did this pass,
  does this parse, is this a bug). We did not choose it. The sweep did — see below.

• Qwen/Qwen3-235B-A22B-Instruct-2507 — the "thinking" tier: codebase investigation, research and
  implementation, plus the documented default for any job not named in the policy, so an unknown
  job is never silently dropped to the cheapest model nor silently escalated to the dearest.

Two models rather than one because the jobs differ in what it costs to be wrong. Routing
everything to the cheapest model would be a worse product than routing nothing: our own
measurement shows the cheap tier giving up real accuracy on harder work, which is precisely why
the policy is tiered instead of flat.

IN THE MEASUREMENT PATH

• deepseek-ai/DeepSeek-V4-Pro — the blind judge. It grades every arm of every experiment against
  each task's rubric without being told which model produced the answer, and it doubles as the
  strong open-weight baseline in the head-to-head.

• Qwen/Qwen3-30B-A3B-Instruct-2507 — the self-consistency gate for the escalation experiment, and
  a cautionary tale: it was the hand-picked mechanical model until realistic fixtures dropped it
  from 95% to 76%, at which point the sweep replaced it with gemma.

• 19 Token Factory text models scored end to end to derive the policy rather than assert it:
  gemma-3-27b-it, gpt-oss-120b, Qwen3-30B, Qwen3-235B, Qwen3.5-397B, DeepSeek-V4-Pro,
  DeepSeek-V4-Flash, DeepSeek-V4.1-Flash, GLM-5.3, GLM-5.3-Flash, Kimi-K3, Kimi-K2.6,
  Kimi-K2.7-Code, Hermes-4-405B, MiniMax-M3, Nemotron-3-Nano, Nemotron-3.5-Lightning,
  Nemotron-3-Super, Nemotron-3-Ultra. Embedding and vision models were excluded because they
  cannot do these jobs; we use no embeddings anywhere.

Model IDs and prices come from the Token Factory API itself (GET /v1/models?verbose=true), not
from third-party aggregators, so every cost figure we publish is priced at the source.

CLOSED MODELS

Yes, and we name them. claude-haiku-4-5, claude-sonnet-5 and claude-opus-5 were called directly
over the Anthropic API as the comparison baseline — 21 tasks each, same blind judge, total spend
$0.0683. They exist in our results to be measured against, not to serve traffic. claude-opus-5 is
also configured in policy.yaml for the one high-stakes job (code review) and has never been
invoked, which we say plainly rather than counting it as shipped.

## Measurable model advantage

PROOF: https://ax-route.vercel.app  (every figure on the page names the file it came from)
Raw data, reproducible: /frontier.json /sweep.json /bench.json /escalate.json /replay.json
Commands: route frontier | route sweep | route bench | route escalate | route replay

BASELINE 1 — CLOSED MODELS, CALLED FOR REAL

21 realistic tasks: actual stack traces, YAML config, source files, git history and raw usage
records from these repositories. One judge grades every arm against each task's rubric, blind to
which model answered. Nothing below is arithmetic.

  model                             quality   cost (21 tasks)   p50 latency
  google/gemma-3-27b-it (Nebius)      95.2%       $0.000319         378 ms
  claude-haiku-4-5  (Anthropic)       90.5%       $0.003697         814 ms
  claude-sonnet-5   (Anthropic)         81%       $0.013938        1693 ms
  claude-opus-5     (Anthropic)       95.2%       $0.050645        2564 ms

An open model on Token Factory matched claude-opus-5 exactly — 95.2% against 95.2% — at 159x
lower cost and 6.8x lower latency. It also beat claude-haiku-4-5 on quality while costing 12x
less. Whole Anthropic baseline run: $0.0683.

BASELINE 2 — THE WHOLE CATALOGUE, NOT A FLATTERING PAIR

All 19 Token Factory text models, same tasks, same judge. Quality spans 66.7-95.2%. Price spans
172x. The single most expensive model tested (Qwen3.5-397B, $2.6083 per 1k tasks) scored the
worst of all nineteen at 66.7%. Price predicts close to nothing about quality on this work, which
is the entire argument for measuring instead of guessing.

BASELINE 3 — OUR OWN PREVIOUS APPROACH, WHICH THE MEASUREMENT KILLED

policy.yaml named Qwen3-30B, picked by hand. Against an earlier set of toy fixtures ("does this
JSON parse") it scored 95.2%. Against the realistic set it scored 76.2% and failed the 90% bar,
so the sweep replaced it with gemma-3-27b-it. The tool overruled its author, in public, and the
commit history shows both numbers.

CONTROL OVER BEHAVIOUR

Routing is declared in a file a human reads, never inferred from prompt text, so there is no
second model guessing intent and no silent promotion to a dearer tier. Every call appends one
auditable line: job, tier, model, tokens, cost, latency, region. 3 of 8 jobs are marked
deployable because fixtures back them; 5 are marked untested and the tool refuses to recommend
them.

A NEGATIVE RESULT WE KEPT

Automatic escalation does not work yet. Asking the cheap model whether its own answer looked
complete escalated 1 task in 21 and changed nothing. Escalating on self-disagreement escalated
19%, cost 4.8x more, and still scored 81% — exactly what the cheap model scored alone. A cheap
general-purpose confidence gate cannot see wrongness, because a small model is wrong confidently
and in good form. A gate that works has to verify against the task itself.

A CORRECTION WE FOUND OURSELVES

The replay first reported $164.40. cost() subtracted cached tokens from an input count that
already excluded them, so every cached token billed at zero — and on real traffic cache reads
outnumber fresh input roughly fifty to one. The true figure is $664.87. It surfaced while writing
a fixture that asks a model to spot exactly that bug. Fixing it made the problem four times
larger.

WHAT IT IS WORTH

3,985 real requests over 50 days, re-priced from raw tokens: $664.87. Routing half of that work
takes the bill to $391.98, a 41% saving; at 75% it is $255.53. Reported as a 25/50/75 band
because the mechanical share is an assumption, not a measurement.

## Responsible design

The audit reads the logs your AI tools already keep on your own machine and never sends them
anywhere: it emits aggregates only — counts, tokens and dollars — and because project names are
often client names, the published output carries stable labels like "C-01" rather than the real
thing, with `--reveal` staying local and opt-in. API keys are read from the environment or the
macOS Keychain and never written to the repository, gitleaks gates every commit, and open weights
run in Nebius's Finland region so source code never leaves the EU.

When the model gets it wrong you can see exactly why: every call appends one auditable line
naming the job, model, tokens, cost and region, and any job can be pinned to a higher tier by
editing one line of a policy file a human can read — routing is declared, never inferred from
prompt text, so nothing is silently downgraded. Most importantly the tool refuses to recommend
what it has not tested: 3 of 8 jobs are marked deployable and 5 are marked untested, because a
router that painted all eight green would be guessing on five and the user would find out the
expensive way.

## Pitch slides

https://ax-route.vercel.app/deck.html

11 slides, arrow keys or click, `F` for fullscreen. Covers all six criteria:
product and user value (2–3), problem and company potential (2, 3, 10), measurable model
advantage (6, 7, 8, 9), technical execution and Token Factory use (5, 6), demo clarity (5 is the
live demo cue), responsible design (8, 11).
