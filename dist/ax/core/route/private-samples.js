// Real prompts an operator can feed the bench for a truer read of pass rate, without ever putting
// prompt text or results derived from them in the committed evidence. Samples live only under
// state/route/private-samples/ (state/ is gitignored, never synced or exported) and this module is
// the boundary: it loads them, and it refuses to let a result derived from one reach anything public
// (evals/route/results/, the export mirror). Missing directory is the common case, not an error.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AX } from "../usage/store.js";
import { loadPrivacy } from "../judge/sessions.js";
import { scrub } from "./delegate-tools.js";
// Reads every *.json file under <stateRoot>/route/private-samples/ (each file is a Fixture[] or a
// single Fixture). Never throws for the no-samples case; a malformed file is the caller's problem.
export function loadPrivateSamples(stateRoot) {
    const dir = join(stateRoot, "route", "private-samples");
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
        for (const fixture of Array.isArray(raw) ? raw : [raw])
            out.push({ ...fixture, private: true });
    }
    return out;
}
export const privateIdsOf = (samples) => new Set(samples.map((s) => s.id));
// Strips internal bookkeeping — the `private` tag and anything else not in Fixture — before a
// fixture reaches an external call (the candidate model or the blind judge, both real network
// calls). External services see a plain Fixture, never that it came from a private sample.
export function scrubFixtureForCall(f, privacyFile = join(AX, "config", "privacy.yaml")) {
    const privacy = loadPrivacy(privacyFile);
    const clean = (text) => {
        if (text === undefined)
            return undefined;
        const clientSafe = privacy.terms ? text.replace(privacy.terms, "[client]") : text;
        return scrub(clientSafe);
    };
    return { id: f.id, job: f.job, prompt: clean(f.prompt), system: clean(f.system), rubric: clean(f.rubric) };
}
// Throws if any result was derived from a private fixture id. Call this before writing to
// evals/route/results/, the dashboard's evidence view, or the public mirror export — anywhere a
// result could otherwise leak a private prompt or its pass/fail into something committed or shown.
export function assertPublicSafe(results, privateIds) {
    const leaked = results.filter((r) => privateIds.has(r.fixtureId));
    if (leaked.length) {
        throw new Error(`refusing to publish ${leaked.length} result(s) derived from private samples: ${leaked.map((r) => r.fixtureId).join(", ")}`);
    }
}
