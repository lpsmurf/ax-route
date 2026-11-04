import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync } from "node:fs";
import { findFiles, jsonl, projectOf, n } from "./files.js";
import { billingFromUrl, planFrom } from "./billing.js";
export const openclawHome = () => process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
// OpenClaw prices every call from its own model table whatever the auth, so a reported cost does not
// prove the operator paid it. Billing comes from the provider's configured endpoint in openclaw.json.
function billingOf(m, url) {
    const byUrl = billingFromUrl(url);
    if (byUrl)
        return byUrl;
    const via = `${m.provider ?? ""} ${m.api ?? ""}`;
    if (/ollama|lmstudio|llama\.?cpp|vllm/i.test(via))
        return "local";
    if (/codex/i.test(via))
        return "subscription";
    return "unknown";
}
// OpenClaw: model-agnostic gateway. ~/.openclaw/agents/<agent>/sessions/*.jsonl — a session header
// with the working directory, then one message per turn with provider, model and usage.
export function parseOpenclaw(home = openclawHome()) {
    const urls = new Map();
    try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8")).models?.providers ?? {}))
            if (v?.baseUrl)
                urls.set(k, v.baseUrl);
    }
    catch { /* no config */ }
    const out = [];
    for (const file of findFiles(join(home, "agents"), (f) => f.endsWith(".jsonl"))) {
        if (!/[\\/]sessions[\\/]/.test(file))
            continue;
        let project = "unknown", session = basename(file, ".jsonl");
        for (const d of jsonl(file)) {
            if (d?.type === "session") {
                project = projectOf(d.cwd);
                session = d.id ?? session;
                continue;
            }
            const m = d?.message, u = m?.usage;
            if (d?.type !== "message" || m.role !== "assistant" || !u)
                continue;
            if (!(n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite)))
                continue;
            const when = new Date(d.timestamp ?? m.timestamp);
            if (Number.isNaN(when.getTime()))
                continue;
            const url = urls.get(m.provider);
            const planVia = planFrom(url, m.provider);
            out.push({
                tool: "openclaw", billing: billingOf(m, url), ...(planVia ? { planVia } : {}),
                ts: when.toISOString(), session, project, model: m.model || "unknown",
                input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite5m: n(u.cacheWrite), cacheWrite1h: 0,
            });
        }
    }
    return out;
}
