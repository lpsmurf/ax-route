import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { findFiles, jsonl, projectOf, n } from "./files.js";
export const kimiRoot = () => join(homedir(), ".kimi-code", "sessions");
export const kimiV1Home = () => join(homedir(), ".kimi");
// Models served under the Kimi Code membership are prefixed kimi-code/; anything else is metered.
export const kimiBilling = (model) => (/^kimi-code\//.test(model ?? "") ? "subscription" : "api");
// Kimi Code 2.x: ~/.kimi-code/sessions/wd_<name>_<hash>/<session>/agents/<agent>/wire.jsonl, with the
// session's cwd in <session>/state.json. Usage comes from `usage.record` events (scope "turn", so one
// row per turn, not per request). The same numbers are echoed inside `context.append_loop_event`;
// those are ignored. inputOther excludes cache reads/writes.
export function parseKimi(root = kimiRoot()) {
    const seen = new Set();
    const out = [];
    for (const file of findFiles(root, (f) => f === "wire.jsonl")) {
        const sessionDir = dirname(dirname(dirname(file)));
        const session = basename(sessionDir);
        let project = "unknown";
        try {
            project = projectOf(JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf8")).cwd);
        }
        catch { /* no state.json */ }
        for (const d of jsonl(file)) {
            if (d?.type !== "usage.record" || !d.usage)
                continue;
            const u = d.usage;
            const key = `${session}:${d.agentId}:${d.time}:${u.inputOther}:${u.output}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({
                tool: "kimi",
                billing: kimiBilling(d.model),
                ts: new Date(n(d.time)).toISOString(),
                session,
                project,
                model: d.model ?? "unknown",
                input: n(u.inputOther),
                output: n(u.output),
                cacheRead: n(u.inputCacheRead),
                cacheWrite5m: n(u.inputCacheCreation),
                cacheWrite1h: 0,
            });
        }
    }
    return out;
}
// Kimi CLI 1.x: ~/.kimi/sessions/<md5(workdir)>/<session>/wire.jsonl with `StatusUpdate` events,
// deduped on message_id. 1.x does not log the model per call, so the configured default stands in.
// Work dirs are listed in ~/.kimi/kimi.json; the folder name is the md5 of the path.
export function parseKimiV1(home = kimiV1Home()) {
    let model = "unknown";
    try {
        model = /^default_model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1] ?? model;
    }
    catch { /* no config */ }
    const dirs = new Map();
    try {
        for (const w of JSON.parse(readFileSync(join(home, "kimi.json"), "utf8")).work_dirs ?? [])
            if (w?.path)
                dirs.set(createHash("md5").update(w.path).digest("hex"), w.path);
    }
    catch { /* no kimi.json */ }
    const seen = new Set();
    const out = [];
    for (const file of findFiles(join(home, "sessions"), (f) => f === "wire.jsonl")) {
        const session = basename(dirname(file));
        const project = projectOf(dirs.get(basename(dirname(dirname(file)))));
        for (const d of jsonl(file)) {
            const p = d?.message?.payload, u = p?.token_usage;
            if (d?.message?.type !== "StatusUpdate" || !u)
                continue;
            if (p.message_id) {
                if (seen.has(p.message_id))
                    continue;
                seen.add(p.message_id);
            }
            out.push({
                tool: "kimi",
                billing: kimiBilling(model),
                ts: new Date(n(d.timestamp) * 1000).toISOString(),
                session,
                project,
                model,
                input: n(u.input_other),
                output: n(u.output),
                cacheRead: n(u.input_cache_read),
                cacheWrite5m: n(u.input_cache_creation),
                cacheWrite1h: 0,
            });
        }
    }
    return out;
}
