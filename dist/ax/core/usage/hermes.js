import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { projectOf, n } from "./files.js";
import { billingFromUrl, planFrom } from "./billing.js";
export const hermesDb = () => join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), "state.db");
// node:sqlite is built into Node >= 22.5 and prints an ExperimentalWarning on load; silence only that.
// Loaded through require so the test bundler does not try to resolve it.
function sqlite() {
    const warn = process.emitWarning;
    process.emitWarning = ((w, ...a) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : warn.call(process, w, ...a)));
    try {
        return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
    }
    catch {
        return undefined;
    }
    finally {
        process.emitWarning = warn;
    }
}
const cols = (t) => `${t}model model, ${t}billing_provider provider, ${t}billing_base_url base_url, ${t}billing_mode mode,
  ${t}api_call_count calls, ${t}input_tokens input, ${t}output_tokens output, ${t}cache_read_tokens cache_read,
  ${t}cache_write_tokens cache_write, ${t}actual_cost_usd actual, ${t}estimated_cost_usd estimated`;
// Per-model rows where they exist, plus whole-session rows for sessions that predate that table.
const PER_MODEL = `select u.session_id sid, ${cols("u.")}, coalesce(u.first_seen, s.started_at) at, coalesce(s.git_repo_root, s.cwd) cwd
  from session_model_usage u left join sessions s on s.id = u.session_id`;
const ORPHANS = `select s.id sid, ${cols("s.")}, s.started_at at, coalesce(s.git_repo_root, s.cwd) cwd from sessions s
  where not exists (select 1 from session_model_usage u where u.session_id = s.id)`;
const SESSIONS = `select id sid, ${cols("")}, started_at at, null cwd from sessions`;
function billingOf(r) {
    if (/subscription/i.test(r.mode ?? "") || /codex/i.test(r.provider ?? ""))
        return "subscription";
    const byUrl = billingFromUrl(r.base_url);
    if (byUrl)
        return byUrl;
    if (/ollama|lmstudio|llama/i.test(r.provider ?? ""))
        return "local";
    if (n(r.actual) > 0 || n(r.estimated) > 0)
        return "api";
    return "unknown";
}
// Hermes Agent: model-agnostic, so it records per session AND per model which provider served the
// tokens and how they were billed (~/.hermes/state.db). One event per session+model, carrying its call count.
export function parseHermes(db = hermesDb()) {
    if (!existsSync(db))
        return [];
    const Database = sqlite();
    if (!Database)
        return [];
    const conn = new Database(db, { readOnly: true });
    let rows;
    try {
        try {
            rows = [...conn.prepare(PER_MODEL).all(), ...conn.prepare(ORPHANS).all()];
        }
        catch {
            rows = conn.prepare(SESSIONS).all();
        }
    }
    finally {
        conn.close();
    }
    return rows
        .filter((r) => n(r.input) + n(r.output) + n(r.cache_read) + n(r.cache_write) > 0 && r.at)
        .map((r) => {
        const planVia = planFrom(r.provider, r.base_url);
        return {
            tool: "hermes", billing: billingOf(r), ...(planVia ? { planVia } : {}),
            ts: new Date(n(r.at) * 1000).toISOString(), session: String(r.sid ?? ""), project: projectOf(r.cwd),
            model: r.model || "unknown", requests: Math.max(1, n(r.calls)),
            input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite5m: n(r.cache_write), cacheWrite1h: 0,
        };
    });
}
