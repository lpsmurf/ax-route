# Tasks 001 — Route

Deadline 15:00, 23 Sep 2026. Cut line at 13:40.

- [ ] T100 Repo scaffold, .gitignore, .env.example, package.json
- [ ] T101 Spec kit (spec / plan / tasks)
- [ ] T102 Confirm Token Factory base URL + model ids via live `GET /v1/models`
- [ ] T103 `prices.yaml` — Nebius live + frontier from ax-harness `config/models.yaml`, each sourced
- [ ] T104 `policy.yaml` — the 8 ax-harness subagent roles → Token Factory models
- [ ] T200 `src/price.mjs` + longest-prefix lookup
- [ ] T201 `src/policy.mjs` + nested-YAML parser
- [ ] T202 `src/ledger.mjs`
- [ ] T203 `src/proxy.mjs` — first real Token Factory call through the proxy
- [ ] T204 `bin/route serve`
- [ ] T300 `bench/fixtures/*.json` — ~20 tasks across the 8 roles
- [ ] T301 `src/bench.mjs` — two arms, blind judge
- [ ] T302 Run bench → `results/bench.json`
- [ ] T400 `src/replay.mjs` — reconcile $2,000.19 actual, then counterfactual
- [ ] T401 Run replay → `results/replay.json`
- [ ] T500 `web/` dashboard, every figure citing its source file
- [ ] T501 Deploy to Vercel
- [ ] T600 README + npx packaging
- [ ] T601 SUBMISSION.md — the six fields the brief demands
- [ ] T602 gitleaks clean, push public, submit
