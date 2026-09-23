# Plan 001 — Route

## Shape
Node 20, zero runtime dependencies, Node built-ins only — the same discipline as `ax/dashboard/`,
which this borrows its view primitives from. No bundler, no framework, no database. The repo is
the product; `npx ax-route` is the install.

## Modules
| File | Responsibility |
|---|---|
| `src/policy.mjs` | Parse `policy.yaml`; `resolve(job) -> {model, provider, tier, reason}`. Own ~15-line parser: the harness `frontmatter()` mini-parser cannot handle nested `agents:`/`tiers:`. |
| `src/price.mjs` | Parse `prices.yaml`; `cost(model, usage) -> usd \| null`. Longest-prefix match so dated ids resolve. Shared by proxy, bench and replay so one table drives every number. |
| `src/proxy.mjs` | `node:http` server. Reads `x-route-job`, resolves policy, forwards to Token Factory, passes the response through, appends to ledger. |
| `src/ledger.mjs` | Append-only JSONL writer + reader. One line per call. |
| `src/bench.mjs` | Fixtures × arms → call, grade with a blind judge, aggregate to `results/bench.json`. |
| `src/replay.mjs` | Read real usage records → actual cost vs Route counterfactual → `results/replay.json`. |
| `bin/route` | CLI: `serve` \| `bench` \| `replay`. |
| `web/` | Static dashboard reading the committed `results/*.json`. |

## Key decisions
1. **OpenAI wire format, not Anthropic.** Token Factory is OpenAI-compatible, so the proxy is a
   near-passthrough and works with Codex, Cursor, Continue and the OpenAI SDK today. The
   Anthropic adapter that would unlock Claude Code is named as next work, not claimed as shipped.
2. **Job declared, not inferred.** Inferring intent from prompt text would be a second model call
   and a new failure mode. The caller names the job; the policy file decides. Auditable.
3. **Two-legged evidence.** Replay gives breadth from real dollars; the benchmark gives depth on
   quality. Neither is presented as the other. Fixtures are hand-authored against real repo
   content and labelled as such.
4. **Blind judge, same grader both arms.** Otherwise the quality claim is worthless.
5. **Null over guess.** An unpriced model reports `null`, never an estimate. Same rule the
   harness uses in `scan-harness.mjs`.

## Risks
| Risk | Mitigation |
|---|---|
| Token Factory model ids/prices differ from published pages | Confirm live via `GET /v1/models` before writing `prices.yaml`. Do not trust cached web copy. |
| Benchmark too small to mean anything | Report n and per-job breakdown; never a single headline pass rate without its sample size. |
| Open weights lose on quality | That is a finding, not a failure. Report it and narrow the claim to the jobs where they win. |
| Time | Hard cut line at 13:40 — drop to 10 fixtures, drop escalation, static results page. |
