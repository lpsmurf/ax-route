// Shared shapes for the route evidence benchmark (spec 003 phase 3). A "fixture" is one task; a
// "sample" is one (model, fixture) run judged pass/fail by a blind judge that never sees which model
// answered. Evidence is always this measured shape, never a hard-coded list (spec 003 T033).
// Job ids become directory and file name segments (evidence.ts results/<job>/, cli.ts fixtures/<job>.json,
// sampler.ts candidates/<job>.json) — restricted to a safe charset so a crafted --job value can never
// escape its own directory (path traversal, e.g. "../../etc").
const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export function assertValidJob(job) {
    if (!SAFE_JOB_ID.test(job))
        throw new Error(`invalid job id "${job}": expected letters, digits, "-" or "_" only`);
}
