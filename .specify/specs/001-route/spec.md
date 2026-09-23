# Spec 001 — Route

## Why
Agent work is billed at frontier prices regardless of how mechanical the job is. Measured on one
machine over 103 days (2026-06-12 → 2026-09-23, `usage/*.jsonl` in the ax-harness repo):
**$2,000.19** of agent spend — claude $1,787.94, codex $198.66, kimi $13.59, with `claude-opus-5`
alone accounting for $660.83. The ax-harness already declares a cheapest-capable tier for each of
its 8 subagent roles in `config/models.yaml`, but **nothing parses or enforces it**
(`.specify/specs/001-ax-harness/tasks.md:32`, T304, unchecked). The policy exists on paper and
costs nothing in practice.

Meanwhile open-weight models crossed the quality line for mechanical work — retrieval,
extraction, mechanical QA — and Nebius Token Factory serves them from the EU at a published
per-token price. The gap between the declared policy and the actual bill is the product.

## Who it is for
Luis first — 20+ projects, two Macs, 8 subagent roles, the $2,000.19 above. Then any team running
agents at volume, and specifically European teams that cannot send source code to US frontier
APIs.

## Scope
**In (v1):** OpenAI-compatible routing endpoint; declarative job→model policy; price table with
cited sources; append-only ledger; head-to-head benchmark against a frontier arm; replay of real
historical usage; a dashboard that cites its source file for every number.

**Out (v1):** Anthropic wire-format adapter (Claude Code support); streaming; fine-tuning;
multi-tenant hosting; automatic policy learning.

## Requirements
| ID | Requirement |
|---|---|
| FR-1 Endpoint | `POST /v1/chat/completions`, OpenAI-compatible. Works unmodified with any OpenAI client. Response body is passed through untouched. |
| FR-2 Job | Caller declares a job via `x-route-job` header, or a `route/<job>` model alias. Unknown job → documented default tier, never a silent frontier call. |
| FR-3 Policy | `policy.yaml` maps job → model → provider. Human-readable, version-controlled, the single source of routing truth. A job may be pinned to a tier. |
| FR-4 Price | `prices.yaml` gives $/1M input and output per model, each entry naming its source and confidence. A model with no price yields `cost_usd: null`, never a guess. |
| FR-5 Ledger | Every routed call appends one JSONL line: timestamp, job, model, provider, token counts, cost, latency, outcome. Append-only; the audit trail is the product. |
| FR-6 Benchmark | `route bench` runs fixtures through a Token Factory arm and a frontier arm, grades both with the same judge blind to arm, and reports pass rate, cost and p50/p95 latency per arm. |
| FR-7 Replay | `route replay` re-prices real historical usage under the policy: actual paid vs Route counterfactual. Must reconcile the actual total against source data before reporting any saving. |
| FR-8 Dashboard | Single page. Every figure names the file it came from. Readable at phone width and at 1024px. |
| FR-9 Secrets | `NEBIUS_API_KEY` from env or Keychain only. No key in any committed file. gitleaks gates the push. |

## Success criteria
- A real Token Factory completion returns through the proxy and appends exactly one ledger line
  with a non-zero cost.
- The benchmark shows the Token Factory arm at materially lower cost than the frontier arm **at a
  pass rate within noise of it** on mechanical jobs — or reports honestly that it does not.
- The replay reproduces $2,000.19 from source data before showing any counterfactual.
- A reader can install and run it from the README in under five minutes.

## Non-goals, stated plainly
Route does not claim to make a cheap model as good as a frontier model at everything. It claims
the opposite is being paid for: that a large share of agent calls are mechanical, and that those
calls do not need a frontier model. The benchmark is designed to be able to disprove this.
