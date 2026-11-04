// Turns committed bench results into per-job routing evidence: the cheapest deployable model, or
// "untested" when none has cleared the bar with enough samples. Never a hard-coded list (spec 003
// T033/T039a) — every choice traces back to the result file it came from (Gate III). Reads whatever
// `ax route bench` last wrote for a job; a job with no result file at all is untested, not an error.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_BAR, MIN_DEPLOYABLE_SAMPLES, cheapestCapable, recomputeDeployable } from "./bench.js";
import { loadPriceBook, priceFor } from "../usage/pricing.js";
import { AX } from "../usage/store.js";
import { assertValidJob } from "./types.js";
// `ax route bench` writes the full BenchResult (minus samples, see cli.ts) here; this is a staging
// area, not yet promoted into the committed evals/route/results/ (that promotion is a manual,
// reviewed step — evidence.ts reads both so a promoted result and a fresh local run are both seen).
export const stateResultsDir = (ax = AX) => join(ax, "state", "route", "results");
export const publicResultsDir = (ax = AX) => join(ax, "evals", "route", "results");
export function defaultResultDirs(ax = AX) {
    return [publicResultsDir(ax), stateResultsDir(ax)];
}
// Every `<dir>/<job>/*.json` file across `dirs` for one job. Missing directories are the common
// case (no bench has run yet for that job), not an error.
export function loadJobResults(job, dirs) {
    assertValidJob(job); // job becomes `<dir>/<job>/` — refuse anything that could walk out of it
    const out = [];
    for (const dir of dirs) {
        const jobDir = join(dir, job);
        if (!existsSync(jobDir))
            continue;
        for (const name of readdirSync(jobDir).filter((f) => f.endsWith(".json"))) {
            const path = join(jobDir, name);
            try {
                out.push({ path, result: JSON.parse(readFileSync(path, "utf8")) });
            }
            catch { /* a malformed result file is skipped, not fatal to the others */ }
        }
    }
    return out;
}
// Most recent result file for a job, by `generatedAt`. Bench results are only ever compared within
// the same job — there is no cross-job merging here, so a job's evidence is always traceable to one
// run (Gate III).
export function latestResultForJob(job, dirs) {
    const files = loadJobResults(job, dirs);
    if (!files.length)
        return null;
    // A result file missing generatedAt (hand-edited, or written before that field existed) sorts as
    // oldest rather than throwing.
    return [...files].sort((a, b) => String(b.result.generatedAt ?? "").localeCompare(String(a.result.generatedAt ?? "")))[0];
}
const untested = (job) => ({ job, models: [], choice: null, source: null, generatedAt: null });
export function evidenceForJob(job, dirs = defaultResultDirs(), book) {
    const latest = latestResultForJob(job, dirs);
    if (!latest)
        return untested(job);
    // cheapestCapable recomputes deployable against the absolute floors itself; recompute the models
    // list the same way so the dashboard never shows a "deployable" pill the read-time check disagrees with.
    const capable = cheapestCapable(latest.result);
    let currentBook = book;
    if (!currentBook) {
        try {
            currentBook = loadPriceBook(join(AX, "config", "models.yaml"));
        }
        catch {
            currentBook = undefined;
        }
    }
    const currentlyPriced = capable && currentBook ? priceFor(currentBook, capable.model) : undefined;
    const choice = capable && currentlyPriced
        ? { job, model: capable.model, passRate: capable.passRate, costPerTaskUsd: capable.costPerTaskUsd, samples: capable.samples, evidence: latest.path }
        : null;
    return { job, models: latest.result.models.map(recomputeDeployable), choice, source: latest.path, generatedAt: latest.result.generatedAt ?? null };
}
export function evidenceForJobs(jobs, dirs = defaultResultDirs()) {
    return jobs.map((job) => evidenceForJob(job, dirs));
}
const badConfig = (path, why) => { throw new Error(`config/models.yaml routing.${path}: ${why}`); };
const isMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
// `routing` is the value under the `routing:` key. Absent -> no roles, floors only.
export function parseRouting(routing) {
    if (routing === undefined || routing === null)
        return { bar: DEFAULT_BAR, minSamples: MIN_DEPLOYABLE_SAMPLES, roles: {} };
    if (!isMap(routing))
        return badConfig("", "expected a mapping");
    const th = isMap(routing.thresholds) ? routing.thresholds : {};
    if (routing.thresholds !== undefined && !isMap(routing.thresholds))
        badConfig("thresholds", "expected a mapping");
    const bar = th.bar ?? DEFAULT_BAR;
    const minSamples = th.min_samples ?? MIN_DEPLOYABLE_SAMPLES;
    if (typeof bar !== "number" || !(bar >= DEFAULT_BAR && bar <= 1))
        return badConfig("thresholds.bar", `expected a number from ${DEFAULT_BAR} to 1 (the floor can only be tightened)`);
    if (typeof minSamples !== "number" || !Number.isInteger(minSamples) || minSamples < MIN_DEPLOYABLE_SAMPLES)
        return badConfig("thresholds.min_samples", `expected an integer >= ${MIN_DEPLOYABLE_SAMPLES}`);
    if (routing.roles !== undefined && !isMap(routing.roles))
        return badConfig("roles", "expected a mapping of role name to policy");
    const roles = {};
    for (const [name, r] of Object.entries((routing.roles ?? {}))) {
        if (!isMap(r))
            return badConfig(`roles.${name}`, "expected a mapping");
        if (typeof r.job !== "string")
            return badConfig(`roles.${name}.job`, "expected a job id");
        try {
            assertValidJob(r.job);
        }
        catch (e) {
            return badConfig(`roles.${name}.job`, e.message);
        }
        const allowed = r.allowed;
        if (!Array.isArray(allowed) || !allowed.length || allowed.some((m) => typeof m !== "string" || !m))
            return badConfig(`roles.${name}.allowed`, "expected a non-empty list of model ids");
        const preferred = r.preferred;
        if (preferred !== undefined && (typeof preferred !== "string" || !allowed.includes(preferred)))
            return badConfig(`roles.${name}.preferred`, "must be one of allowed");
        roles[name] = { job: r.job, allowed: allowed, preferred: preferred ?? null };
    }
    return { bar, minSamples, roles };
}
export function loadRouting(file) {
    return parseRouting((parse(readFileSync(file, "utf8")) ?? {}).routing);
}
export function resolveRoles(o) {
    const declared = new Map(o.agents.map((a) => [a.name, a.model || null]));
    const names = [...new Set([...declared.keys(), ...Object.keys(o.policy.roles)])].sort();
    const cache = new Map();
    const evidenceOf = (job) => { let e = cache.get(job); if (!e) {
        e = o.evidence(job);
        cache.set(job, e);
    } return e; };
    return names.map((role) => {
        const pol = o.policy.roles[role];
        const base = { role, declared: declared.get(role) ?? null };
        if (!pol)
            return { ...base, job: null, allowed: [], preferred: null, status: "no-policy", routedModel: null, evidence: null };
        const ev = evidenceOf(pol.job);
        const inPolicy = ev.models.filter((m) => pol.allowed.includes(m.model));
        const info = (m) => ({ model: m.model, samples: m.samples, passRate: m.passRate, costPerTaskUsd: m.costPerTaskUsd, p50LatencyMs: m.p50LatencyMs, source: ev.source, generatedAt: ev.generatedAt });
        const common = { ...base, job: pol.job, allowed: pol.allowed, preferred: pol.preferred };
        if (!ev.models.length)
            return { ...common, status: "untested", routedModel: null, evidence: null };
        const ok = inPolicy.filter((m) => m.deployable && m.costPerTaskUsd !== null && m.passRate >= o.policy.bar && m.samples >= o.policy.minSamples);
        if (!ok.length) {
            const best = [...inPolicy].sort((a, b) => b.passRate - a.passRate)[0];
            return { ...common, status: "not-deployable", routedModel: null, evidence: best ? info(best) : null };
        }
        const pick = ok.find((m) => m.model === pol.preferred) ?? [...ok].sort((a, b) => a.costPerTaskUsd - b.costPerTaskUsd || b.passRate - a.passRate)[0];
        return { ...common, status: "deployable", routedModel: pick.model, evidence: info(pick) };
    });
}
