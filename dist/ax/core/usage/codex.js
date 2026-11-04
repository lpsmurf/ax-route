import { homedir } from "node:os";
import { join } from "node:path";
import { findFiles, jsonl, projectOf, n } from "./files.js";
export const codexRoot = () => join(homedir(), ".codex", "sessions");
// OpenAI semantics: input_tokens INCLUDES cached (and cache-write) tokens; output_tokens includes reasoning.
function tokens(u) {
    const cacheRead = n(u?.cached_input_tokens);
    const cacheWrite = n(u?.cache_write_input_tokens);
    return {
        input: Math.max(0, n(u?.input_tokens) - cacheRead - cacheWrite),
        output: n(u?.output_tokens),
        cacheRead,
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
    };
}
// Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Newer files carry one `token_usage_record` per response; use those when present.
// Older files only have `event_msg/token_count`, repeated while nothing changed, so count
// `last_token_usage` only when the running total moves (it can move down after a resume).
export function scanCodex(root = codexRoot()) {
    const events = [];
    const snapshots = [];
    for (const file of findFiles(root, (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))) {
        const lines = [...jsonl(file)];
        const hasRecords = lines.some((d) => d?.type === "token_usage_record");
        let model = "unknown", project = "unknown", session = "", prevTotal;
        for (const d of lines) {
            const p = d?.payload ?? {};
            if (d?.type === "session_meta") {
                project = projectOf(p.cwd);
                session = p.id ?? session;
            }
            else if (d?.type === "turn_context" && p.model) {
                model = p.model;
                if (p.cwd)
                    project = projectOf(p.cwd);
            }
            else if (hasRecords && d?.type === "token_usage_record" && p.usage) {
                events.push({ tool: "codex", ts: d.timestamp, session: p.session_id ?? session, project, model, ...tokens(p.usage) });
            }
            if (d?.type === "event_msg" && p.type === "token_count") {
                const rl = p.rate_limits;
                if (rl)
                    snapshots.push({ at: d.timestamp, plan: rl.plan_type ?? undefined, primary: rl.primary ?? undefined, secondary: rl.secondary ?? undefined });
                if (hasRecords || !p.info)
                    continue;
                const total = n(p.info.total_token_usage?.total_tokens);
                if (total === prevTotal)
                    continue;
                prevTotal = total;
                events.push({ tool: "codex", ts: d.timestamp, session, project, model, ...tokens(p.info.last_token_usage) });
            }
        }
    }
    // A ChatGPT plan shows up as plan_type on the rate-limit readings; without one, Codex runs on an API key.
    const billing = snapshots.some((s) => s.plan) ? "subscription" : "api";
    for (const e of events)
        e.billing = billing;
    return { events, snapshots };
}
export const parseCodex = (root = codexRoot()) => scanCodex(root).events;
// The latest reading of each window plus its peak over the last 30 days.
export function codexLimits(snapshots, now = Date.now()) {
    const sorted = [...snapshots].filter((s) => s.at).sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted.at(-1);
    if (!last)
        return null;
    const since = now - 30 * 86400e3;
    const window = (k) => {
        const w = last[k];
        if (!w)
            return null;
        const recent = sorted.filter((s) => s[k] && Date.parse(s.at) >= since).map((s) => n(s[k].used_percent));
        const resetsAt = typeof w.resets_at === "number" && w.resets_at > 0 ? new Date(w.resets_at * 1000).toISOString() : undefined; // epoch seconds
        return { windowMinutes: n(w.window_minutes), usedPercent: n(w.used_percent), peak30d: Math.max(0, ...recent), ...(resetsAt ? { resetsAt } : {}) };
    };
    return { asOf: last.at, plan: sorted.map((s) => s.plan).filter(Boolean).at(-1) ?? null, primary: window("primary"), secondary: window("secondary") };
}
