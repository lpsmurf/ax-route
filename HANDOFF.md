# Handoff — Route (Accel AI Innovate Amsterdam, 23 Sep 2026)

Written 2026-09-24 at the close of the build session. Everything described here is
committed and pushed to `main` on `git@github.com:lpsmurf/ax-route.git`.

## State: submitted and live

| Artefact | Where | Checked |
|---|---|---|
| Live product | https://ax-route.vercel.app | 200 |
| Pitch deck (10 slides) | https://ax-route.vercel.app/deck.html | 200 |
| How-it-works explainer | https://ax-route.vercel.app/demo.html | 200 |
| Submission answers Q1–Q4 | `/answer-q1.txt` … `/answer-q4.txt` | 200 |
| Repo | https://github.com/lpsmurf/ax-route (public) | clean, 0 ahead / 0 behind |

The dashboard was verified in a browser on 2026-09-24 — renders, no console errors.
Every deployed data file (`bench.json`, `sweep.json`, `replay.json`, `frontier.json`,
`escalate.json`, `harness-usage.json`, `estate.json`) returns 200.

Deploy is `vercel deploy --prod --yes --scope team-41436350s-projects`, then
`vercel alias set <deploy> ax-route.vercel.app`.

## What Route is

One OpenAI-compatible endpoint. Each agent call declares a *job* via `x-route-job`;
`policy.yaml` maps the job to the cheapest model measured capable of it — open weights
on Nebius Token Factory for the mechanical majority, a frontier model where being wrong
is expensive. Every decision is appended to a JSONL ledger with tokens, price and latency,
so the saving is a receipt rather than a claim.

Named customer is the harness owner: 56 projects across two Macs, 8 subagent roles,
**$664.87 of measured agent spend over 50 days**. Not a persona — the invoice is in the repo.

## The numbers, and where each comes from

- **$664.87 actual spend**, 3,985 requests, 72 transcripts, 2026-05-30 → 2026-09-23.
  Source `results/replay.json`, read from `~/.claude/projects/**/*.jsonl`, deduped on `requestId`.
- **$284.17 addressable** — the midpoint of the replay band, defined in `estate.json:summary.basis`.
  The dashboard shows $275.35 from its own `web/estate.json` snapshot; both are midpoints of
  the same band on slightly different scans. If a judge asks, quote the file.
- **Sweep**: 19 models × 21 fixtures, judged blind by `deepseek-ai/DeepSeek-V4-Pro`, 90% bar.
  Winner `google/gemma-3-27b-it` — 95.2% judge, $0.0152 per 1,000 tasks, p50 378 ms.
  Source `results/sweep.json`.
- **Frontier baseline** (measured, not estimated): `claude-opus-5` 95.2% judge;
  `claude-haiku-4-5` 90.5% at 12× the winner's cost; `claude-sonnet-5` 81%.
  Source `results/frontier.json`. Total Anthropic spend for the whole benchmark was well
  under the $12 ceiling the owner set.
- **3 of 8 roles marked deployable.** The other five are untested and the product says so
  rather than claiming them safe (`src/estate.mjs`, `TESTED`).

## What is built vs. what is labelled coming soon

Built: `route audit` / `estate` (keyless, no account, reads local logs), `serve` (the proxy),
`policy`, `sweep`, `bench`, `frontier`, `escalate`, `replay`; the dashboard; the deck.

Labelled "Coming soon" on `demo.html`, honestly: `route apply` (writing the change, not just
naming it), the Anthropic-wire adapter so Claude Code can sit behind Route, browser-side log
scanning, repeat-work detection, the team control plane.

## The single highest-value gap

**Route tells you what to change; it does not change it.** An "Apply changes" view was attempted
twice in-session and reverted both times — first a syntax error, then no time. That is the next
piece of work and it is what turns a report into a product. `route apply` would rewrite the
`model:` line in the three deployable agent files, with a dry-run and a revert.

Second: the Anthropic adapter. Route is OpenAI-wire, so it works with Cursor, Cline, Continue
and the OpenAI SDK today — but the owner's own heaviest spend is Claude Code, which speaks a
different protocol. The gap is named on the page rather than papered over.

## Traps found the hard way — do not re-learn these

1. **Cache pricing.** `cost()` in `src/price.mjs` once subtracted `cache_read` from `input`
   before pricing it. Callers pass *non-cached* input, so the cache term cancelled to zero and
   every cached token was billed at nothing. Replay reported **$164.40**; the true figure was
   **$664.87** — three quarters of the bill hidden. On this traffic cache reads outnumber fresh
   input roughly fifty to one, which the AX Control Room independently confirms at
   "98% served from cache". The comment above `cost()` records this; leave it there.
2. **Toy fixtures flatter models.** The first fixtures were trivial ("does `{"a":1}` parse").
   Rewritten against real stack traces, YAML and source, Qwen3-30B fell 95.2% → 76.2% and failed
   the bar; the sweep replaced it with gemma-3-27b-it. The page says so out loud, because a
   measurement that overrules its author is the strongest thing on the site.
3. **Reasoning models need headroom.** `max_tokens: 300` made Qwen3.5-397B score 20%; at 1200 it
   scored 85%. Scratchpad tokens live in `message.reasoning`, not `message.content`, and they are
   really billed — so report cost per task, never per token.
4. **Verify the live DOM, not the source.** A broken dashboard was live for ~35 minutes because
   an edit cut a template literal in half and `curl | grep` found the text in the source and
   proved nothing. Before every deploy: extract the inline script, `node --check` it, then open
   the deployed page in a browser and read the console.
5. **The nav handler must require `data-v`.** `querySelectorAll('nav a')` catches `#howto`, which
   has none, so a click calls `show(undefined)` and blanks the panel. Use `nav a[data-v]`.
6. **Newer Anthropic models reject `temperature`.** Send it only for `-4-5-|-4-6|-4-7|-4-8`.
7. **`ax sync` ignores `--help` and performs a real sync.** There is no help flag; invoking it
   commits and pushes.

## Open threads, not part of the build

- **Rotate a credential.** What looks like a live Cloudflare API token sits in plaintext at
  `~/dev/memory/private/macmini/-Users-luisploennig-Colosseum-hfsp-labs-colosseum/reference_cloudflare_api.md:19`,
  inside git-tracked `memory/`. Worth rotating.
- **`~/dev` branch drift.** `feat/ax-dashboard-hackathon` is ~20 commits behind `origin/main`.
  Control Room v2 and the `art/` plates exist only on `origin/main`; the working tree has the
  older 7-file zero-dep dashboard and no artwork. Nothing was switched, to avoid disturbing
  harness state mid-hackathon.
- **The pitch was never rehearsed against the clock.** Five minutes, ten slides.

## If you pick this up cold

```bash
cd ~/dev/projects/ax-route
./bin/route audit          # keyless, reads local logs, prints the estate table
./bin/route serve          # proxy on :8787 — needs NEBIUS_API_KEY in env
```

Keys live in macOS Keychain, never in a committed file; only an empty `.env.example` is tracked.
If `serve` reports `EADDRINUSE`, a stale proxy holds 8787 and will serve a cached empty price
table — the error prints the kill command.
