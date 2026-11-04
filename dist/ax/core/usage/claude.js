import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { findFiles, jsonl, projectOf, n } from "./files.js";
export const claudeRoot = () => join(homedir(), ".claude", "projects");
export const claudeAccount = () => join(homedir(), ".claude.json");
// How Claude Code is paid for, from the signed-in account: a Pro/Max login is a subscription, no
// login means an API key. Only billingType is read; identity fields in the same file are ignored.
export function claudeBilling(account = claudeAccount()) {
    try {
        const a = JSON.parse(readFileSync(account, "utf8")).oauthAccount;
        if (!a)
            return "api";
        return /subscription/i.test(a.billingType ?? "") ? "subscription" : "unknown";
    }
    catch {
        return "unknown";
    }
}
// Claude Code transcripts: ~/.claude/projects/<dir>/<session>.jsonl (+ <session>/subagents/*.jsonl).
// An assistant message is written once per content block, so dedupe on message.id + requestId.
// Earlier blocks can carry a partial output count, so the line with the largest output wins.
export function parseClaude(root = claudeRoot(), account = claudeAccount()) {
    const billing = claudeBilling(account);
    const seen = new Map();
    const out = [];
    for (const file of findFiles(root, (f) => f.endsWith(".jsonl"))) {
        for (const d of jsonl(file)) {
            const m = d?.message;
            const u = m?.usage;
            if (d?.type !== "assistant" || !u || !m.model || m.model === "<synthetic>")
                continue;
            const key = m.id && d.requestId ? `${m.id}:${d.requestId}` : undefined;
            const prev = key ? seen.get(key) : undefined;
            if (prev) {
                prev.output = Math.max(prev.output, n(u.output_tokens));
                continue;
            }
            const cc = u.cache_creation;
            const w1h = n(cc?.ephemeral_1h_input_tokens);
            const w5m = cc ? n(cc.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens);
            const e = {
                tool: "claude",
                billing,
                ts: d.timestamp,
                session: d.sessionId ?? "",
                project: projectOf(d.cwd),
                model: m.model,
                input: n(u.input_tokens),
                output: n(u.output_tokens),
                cacheRead: n(u.cache_read_input_tokens),
                cacheWrite5m: w5m,
                cacheWrite1h: w1h,
                ...(u.speed && u.speed !== "standard" ? { speed: u.speed } : {}),
            };
            if (key)
                seen.set(key, e);
            out.push(e);
        }
    }
    return out;
}
