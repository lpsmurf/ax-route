# Five minutes on stage

Run from the repo root. Kill any stray proxy first: `lsof -ti:8787 | xargs kill 2>/dev/null`

## 0:00 — the problem, in one number (say it, don't type it)

> "Over 104 days my agent tools billed $1,240. Three and a half thousand real requests.
> My harness declares that three of its eight job types should run on the cheap model.
> The cheap model ran five of them. Nought point one three percent.
> A tier policy that nothing enforces is a comment, not a control."

## 1:00 — the routing table

```bash
node bin/route policy
```

> "Eight jobs, three tiers. Retrieval, extraction and QA go to open weights on Token Factory.
> Review stays on a frontier model. A human reads this file and knows where every call goes."

## 1:45 — a real call, and the receipt

```bash
node bin/route serve &
curl -s -X POST localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' -H 'x-route-job: qa-test' \
  -d '{"messages":[{"role":"user","content":"Reply only YES or NO: does {\"a\":1} parse as JSON?"}],"max_tokens":20}' | jq -r '.choices[0].message.content'
cat ledger/*.jsonl | tail -1 | jq
```

> "That answer came from Qwen3-30B, served from Finland. And here's the line it wrote:
> job, tier, model, tokens, cost, latency, region. Every decision leaves a receipt.
> The saving isn't a claim — it's an invoice."

## 2:45 — the measurement that sets the policy

Open **https://ax-route.vercel.app**, scroll to the scatter.

> "I didn't pick that model. I tested for it. Nineteen models on Token Factory, same twenty
> tasks, same judge, blind to which model answered.
> Quality: eighty-five to a hundred percent. Price: three hundred and fifty-five times.
> The cloud is flat. On mechanical work you are paying for headroom you never use.
> The cheapest model that clears the bar costs seven-tenths of a cent per thousand tasks.
> Kimi-K3 scores the same and costs two-fifty-nine."

## 3:45 — what it's worth

> "Replayed against fifty days of my real transcripts: route half the work and the bill halves.
> And Nebius serves from Finland — so for a European company this is one product solving two
> problems: the budget line, and the contract that says source code cannot leave the EU."

## 4:30 — close

> "It's open source, it installs with a clone and no dependencies, and every number on that page
> names the file it came from. Route is the enforcement half of a policy my harness has had as a
> comment since day one."

---

## Questions to expect

**"n=20 is small."**
Agreed — say it before they do. Nineteen models × twenty fixtures is 380 graded calls, and the
ranking is stable across the sweep. The quality differences inside the top group are one question
wide; the price differences are 355×. The claim rests on the price spread, not the quality gap.

**"Would the cheap model hold up on harder work?"**
Unknown, and not claimed. The policy routes *mechanical* jobs — retrieval, extraction, QA — and
keeps review on a frontier model precisely because that is where being wrong is expensive.

**"Did you measure against Claude or GPT?"**
No. No frontier key was available during the build, so that comparison is arithmetic over real
token counts and is labelled computed everywhere it appears. The measured head-to-head is against
the largest open model on Token Factory.

**"Why hasn't someone built this?"**
Two years ago the cheap tier couldn't do these jobs, so the routing decision had no upside.
That changed this year. The gap is now 355× at indistinguishable quality.

**"What's the business?"**
Open source router, commercial control plane: shared policies, spend limits, team ledgers,
escalation. It sits in the request path, so value scales with agent usage.
