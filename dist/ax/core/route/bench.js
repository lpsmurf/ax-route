// Measures which Nebius models can do a job well enough to route to it, and at what cost. Ports
// ax-route's sweep.mjs to TypeScript (spec 003 T031). The Nebius call and the judge are both
// injected, so route.test.ts is deterministic and spends nothing live (Gate IX); nebiusCaller and
// nebiusJudge below are the real implementations, used only from `ax route bench` at runtime.
import { readFileSync } from "node:fs";
import { costOf, priceFor } from "../usage/pricing.js";
import { nebiusKey } from "./keys.js";
import { scrubFixtureForCall } from "./private-samples.js";
export const MIN_DEPLOYABLE_SAMPLES = 20; // below this a 100% pass rate is not evidence (spec 003 T033)
export const DEFAULT_BAR = 0.9; // pass-rate bar from ax-route's sweep (results/sweep.json, 2026-09-23)
// Reasoning models emit hidden scratchpad tokens before the answer; a low ceiling truncates them
// mid-thought and scores them as incapable (vault lesson: low max_tokens measures your ceiling).
const MAX_TOKENS = 1200;
export function loadFixtures(file) {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows))
        throw new Error(`${file}: expected a JSON array of fixtures`);
    return rows;
}
// Real Nebius chat completion (OpenAI-wire-compatible). Throws if no usable key is found rather than
// silently returning empty results.
export function nebiusCaller(key = nebiusKey()) {
    if (!key)
        throw new Error("no Nebius key (set NEBIUS_API_KEY or Keychain item NEBIUS_API_KEY)");
    return async (model, fixture) => {
        const start = Date.now();
        const res = await fetch("https://api.studio.nebius.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                max_tokens: MAX_TOKENS,
                messages: [
                    ...(fixture.system ? [{ role: "system", content: fixture.system }] : []),
                    { role: "user", content: fixture.prompt },
                ],
            }),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok)
            return { content: "", inputTokens: 0, outputTokens: 0, latencyMs, error: `HTTP ${res.status}` };
        const body = await res.json();
        const msg = body.choices?.[0]?.message ?? {};
        const u = body.usage ?? {};
        // The answer lives in message.content, the scratchpad in message.reasoning (Nebius) — reading
        // content only is correct here; reasoning is kept for debugging, not judged.
        return {
            content: msg.content ?? "",
            reasoning: msg.reasoning,
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            latencyMs,
        };
    };
}
// Blind judge: sees the fixture's prompt + rubric and the candidate answer, never the model name.
// Default judge model is a frontier Nebius model so the bar means something (ax-route sweep used
// deepseek-ai/DeepSeek-V4-Pro).
export function nebiusJudge(model = "deepseek-ai/DeepSeek-V4-Pro", key = nebiusKey()) {
    if (!key)
        throw new Error("no Nebius key (set NEBIUS_API_KEY or Keychain item NEBIUS_API_KEY)");
    return async (fixture, answer) => {
        const prompt = [
            `Task given to the candidate: ${fixture.prompt}`,
            `Rubric (what a correct answer must satisfy): ${fixture.rubric}`,
            `Candidate answer:\n${answer}`,
            `Reply with JSON only, no prose, no code fences: {"pass": true|false, "reason": "<one short sentence>"}.`,
            `You do not know which model produced this answer; judge the answer alone.`,
        ].join("\n");
        const res = await fetch("https://api.studio.nebius.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
        });
        if (!res.ok)
            return { fixtureId: fixture.id, pass: false, reason: `judge HTTP ${res.status}` };
        const body = await res.json();
        const text = body.choices?.[0]?.message?.content ?? "{}";
        try {
            const parsed = JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ""));
            // Only an exact `true` counts as a pass — a truthy non-boolean (a string, an object) from a
            // model that didn't follow the JSON contract is not evidence of a pass.
            return { fixtureId: fixture.id, pass: parsed.pass === true, reason: parsed.reason };
        }
        catch {
            return { fixtureId: fixture.id, pass: false, reason: "judge returned non-JSON" };
        }
    };
}
function median(xs) {
    if (!xs.length)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// Runs every model against every fixture, scores with the blind judge, and aggregates pass rate,
// $/task and p50 latency per model.
export async function runBench(o) {
    const bar = o.bar ?? DEFAULT_BAR;
    const minSamples = o.minSamples ?? MIN_DEPLOYABLE_SAMPLES;
    const samples = [];
    for (const model of o.models) {
        const price = priceFor(o.book, model);
        for (const rawFixture of o.fixtures) {
            // Scrub before the fixture reaches an external call (the candidate model, then the judge): a
            // private fixture's `private` tag and any other bookkeeping stay local, never sent out.
            const fixture = scrubFixtureForCall(rawFixture);
            const result = await o.call(model, fixture);
            if (result.error) {
                samples.push({ fixtureId: fixture.id, model, pass: false, costUsd: null, latencyMs: result.latencyMs, error: result.error });
                continue;
            }
            const verdict = await o.judge(fixture, result.content);
            // No priced entry in config/models.yaml -> null, never 0 (0 would silently make an unpriced
            // model look free and win on cost).
            const costUsd = price
                ? costOf(price, { input: result.inputTokens, output: result.outputTokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
                : null;
            samples.push({ fixtureId: fixture.id, model, pass: verdict.pass, costUsd, latencyMs: result.latencyMs });
        }
    }
    const models = o.models.map((model) => {
        const rows = samples.filter((s) => s.model === model);
        const passed = rows.filter((s) => s.pass).length;
        const passRate = rows.length ? passed / rows.length : 0;
        const successfulCosts = rows.filter((r) => !r.error && r.costUsd !== null).map((r) => r.costUsd);
        const costPerTaskUsd = successfulCosts.length ? successfulCosts.reduce((s, cost) => s + cost, 0) / successfulCosts.length : null;
        const p50LatencyMs = median(rows.map((r) => r.latencyMs));
        const deployable = costPerTaskUsd !== null && passRate >= bar && rows.length >= minSamples;
        return { model, samples: rows.length, passed, passRate, costPerTaskUsd, p50LatencyMs, deployable };
    });
    return { generatedAt: new Date().toISOString(), bar, minSamples, judge: o.judgeName ?? "blind", models, samples };
}
// Recomputes `deployable` against the absolute floors (DEFAULT_BAR, MIN_DEPLOYABLE_SAMPLES) rather
// than trusting whatever a stored BenchResult says — a result written by `ax route bench --bar 0.5`
// (or an older run, before this floor existed) must not make a model look deployable that wouldn't
// clear the real bar. Also refuses an unpriced model: cost null can never be "capable" (spec 003 review).
export function recomputeDeployable(m) {
    return { ...m, deployable: m.costPerTaskUsd !== null && m.passRate >= DEFAULT_BAR && m.samples >= MIN_DEPLOYABLE_SAMPLES };
}
// The cheapest deployable model for this bench run, ties broken by pass rate then latency. Evidence
// only — returns null rather than falling back to a guess when nothing cleared the bar. Always
// recomputes deployable at read time (see recomputeDeployable), regardless of the bar/minSamples the
// run was invoked with, and never returns an unpriced model.
export function cheapestCapable(result) {
    const capable = result.models.map(recomputeDeployable).filter((m) => m.deployable && m.costPerTaskUsd !== null);
    if (!capable.length)
        return null;
    return [...capable].sort((a, b) => a.costPerTaskUsd - b.costPerTaskUsd || b.passRate - a.passRate || a.p50LatencyMs - b.p50LatencyMs)[0];
}
