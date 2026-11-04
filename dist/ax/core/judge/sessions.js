// Session catalogue for judging: one entry per session with its title and numbers, built from the
// usage parsers plus each tool's title store. Titles stay on this Mac (state/), never in git.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { findFiles, jsonl } from "../usage/files.js";
import { localDate } from "../usage/rollup.js";
import { costOf, priceFor } from "../usage/pricing.js";
const GAP_CAP_MIN = 15;
export function claudeTitles(root = join(homedir(), ".claude", "projects")) {
    const t = new Map();
    for (const f of findFiles(root, (n) => n.endsWith(".jsonl")))
        for (const d of jsonl(f))
            if (d?.type === "custom-title" && d.sessionId && d.customTitle)
                t.set(d.sessionId, d.customTitle);
    return t;
}
export function codexTitles(file = join(homedir(), ".codex", "session_index.jsonl")) {
    const t = new Map();
    if (existsSync(file))
        for (const d of jsonl(file))
            if (d?.id && d.thread_name)
                t.set(d.id, d.thread_name);
    return t;
}
export function kimiTitles(root = join(homedir(), ".kimi-code", "sessions")) {
    const t = new Map();
    for (const f of findFiles(root, (n) => n === "state.json")) {
        // Kimi's non-custom "title" is the first prompt verbatim; keep only its start (privacy: titles, not messages)
        try {
            const s = JSON.parse(readFileSync(f, "utf8"));
            if (s.id && s.title)
                t.set(s.id, s.isCustomTitle ? s.title : s.title.slice(0, 60));
        }
        catch { /* skip */ }
    }
    return t;
}
export function buildSessions(events, book, titles) {
    const groups = new Map();
    for (const e of events) {
        if (!e.session || !e.ts)
            continue;
        const id = `${e.tool}:${e.session}`;
        (groups.get(id) ?? groups.set(id, []).get(id)).push(e);
    }
    const out = [];
    for (const [id, es] of groups) {
        es.sort((a, b) => a.ts.localeCompare(b.ts));
        let active = 0;
        for (let i = 1; i < es.length; i++)
            active += Math.min(GAP_CAP_MIN, (Date.parse(es[i].ts) - Date.parse(es[i - 1].ts)) / 60000);
        const projects = new Map();
        for (const e of es)
            projects.set(e.project, (projects.get(e.project) ?? 0) + 1);
        const cost = es.reduce((s, e) => { const p = priceFor(book, e.model, e.speed); return s + (p ? costOf(p, e) : 0); }, 0);
        out.push({
            id, tool: es[0].tool,
            project: [...projects].sort((a, b) => b[1] - a[1])[0][0],
            title: titles[es[0].tool]?.get(es[0].session) ?? "",
            date: localDate(es[0].ts),
            requests: es.length,
            activeMinutes: Math.round(active),
            tokens: es.reduce((s, e) => s + e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h, 0),
            ioTokens: es.reduce((s, e) => s + e.input + e.output, 0),
            costUsd: Math.round(cost * 100) / 100,
            models: [...new Set(es.map((e) => e.model))],
            cacheShare: (() => { const inp = es.reduce((s, e) => s + e.input + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h, 0); return inp ? Math.round((es.reduce((s, e) => s + e.cacheRead, 0) / inp) * 100) / 100 : 0; })(),
        });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}
export function loadPrivacy(file) {
    const c = existsSync(file) ? parse(readFileSync(file, "utf8")) ?? {} : {};
    const terms = c.client_terms ?? [];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]*");
    return { internal: new Set(c.internal_projects ?? []), terms: terms.length ? new RegExp(terms.map(esc).join("|"), "gi") : null };
}
// The only text an outside judge receives: scrubbed title, tool, models, public project name, numbers.
export function publicView(s, p) {
    const client = !p.internal.has(s.project);
    let title = s.title.slice(0, 80);
    if (p.terms)
        title = title.replace(p.terms, "[client]");
    if (client)
        title = title.replace(new RegExp(s.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[client]");
    return {
        title: title || "(untitled)",
        tool: s.tool,
        models: s.models.join(", "),
        project: client ? "client" : s.project,
        requests: s.requests,
        activeMinutes: s.activeMinutes,
    };
}
