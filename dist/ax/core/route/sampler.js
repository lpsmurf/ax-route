// Cross-tool local sampler (spec 003 T036), deliberately conservative: it finds recent sessions
// across Claude Code, Codex, Kimi, Hermes and OpenClaw using the exact same readers `ax usage`
// already uses (one interface, five adapters, no tool-specific logic here — Gate VIII), but it never
// reads or copies a prompt or a session's text. It writes a manifest: a stable hash, tool, model,
// project, timestamp and token counts per session — enough for a human to go find one of these
// sessions in the tool's own transcript and decide, by hand, whether to add it as a private fixture
// under state/route/private-samples/ (private-samples.ts). This file must never grow a code path
// that reads prompt/session text automatically; that decision stays a human, per-session, opt-in.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaude } from "../usage/claude.js";
import { scanCodex } from "../usage/codex.js";
import { parseHermes } from "../usage/hermes.js";
import { parseKimi, parseKimiV1 } from "../usage/kimi.js";
import { parseOpenclaw } from "../usage/openclaw.js";
import { AX } from "../usage/store.js";
import { assertValidJob } from "./types.js";
export const REVIEW_INSTRUCTIONS = "This manifest lists local sessions by hash only — no prompt or session text is read or stored. " +
    "To turn one into evidence: open that session in its own tool (match on tool + timestamp), copy " +
    "only what you're comfortable redacting-and-including, and add it by hand as a Fixture under " +
    "state/route/private-samples/*.json. Nothing here is exported, judged or read automatically.";
// Every reader `ax usage scan` already has, called read-only exactly as it is there — this module
// adds no new parsing of tool internals, only a stricter, hash-only projection of the same events.
export function collectSessionEvents(roots) {
    const codex = scanCodex(roots?.codex);
    return [
        ...parseClaude(roots?.claude?.root, roots?.claude?.account),
        ...codex.events,
        ...parseKimi(roots?.kimi),
        ...parseKimiV1(roots?.kimiV1),
        ...parseHermes(roots?.hermes),
        ...parseOpenclaw(roots?.openclaw),
    ];
}
function hashOf(e) {
    return createHash("sha256").update(`${e.tool}|${e.session}|${e.ts}|${e.model}`).digest("hex").slice(0, 16);
}
export function toCandidates(events, job) {
    const sessions = new Map();
    for (const e of events) {
        const key = `${e.tool}\u0000${e.session}\u0000${e.model}\u0000${e.project}`;
        const found = sessions.get(key);
        if (found) {
            if (e.ts < found.ts)
                found.ts = e.ts;
            found.inputTokens += e.input;
            found.outputTokens += e.output;
            continue;
        }
        sessions.set(key, {
            hash: hashOf(e), tool: e.tool, ...(job ? { job } : {}), model: e.model, project: e.project,
            ts: e.ts, inputTokens: e.input, outputTokens: e.output,
        });
    }
    return [...sessions.values()].sort((a, b) => b.ts.localeCompare(a.ts));
}
export function buildManifest(events, job) {
    const candidates = toCandidates(events, job);
    return { generatedAt: new Date().toISOString(), ...(job ? { job } : {}), count: candidates.length, candidates, reviewInstructions: REVIEW_INSTRUCTIONS };
}
export const candidatesDir = (ax = AX) => join(ax, "state", "route", "private-samples", "candidates");
// Writes `<dir>/candidates.json` (or `<dir>/<job>.json` when a job is given) — always the manifest
// only, never a candidate's prompt/session text. `events` is injectable so tests never touch a real
// tool's logs.
export function writeCandidateManifest(dir = candidatesDir(), job, events = collectSessionEvents()) {
    if (job)
        assertValidJob(job); // becomes `<dir>/<job>.json` — refuse anything that could walk out of it
    const manifest = buildManifest(events, job);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, job ? `${job}.json` : "candidates.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}
