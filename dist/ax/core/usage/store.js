import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
export const AX = process.env.AX_HOME ?? join(process.env.HOME ?? "", "dev");
export const machineName = () => process.env.AX_MACHINE ?? hostname().replace(/\.local$/, "");
export const usageDir = (ax = AX) => join(ax, "usage");
// Write to a temp file and rename: the dashboard reads these files while a background scan rewrites them.
function writeAtomic(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
}
export function readRows(file) {
    if (!existsSync(file))
        return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function readAllRows(dir = usageDir()) {
    if (!existsSync(dir))
        return [];
    // <machine>.jsonl only; <machine>.activity.jsonl holds judge totals, a different row type
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".activity.jsonl")).flatMap((f) => readRows(join(dir, f)));
}
// Merge a fresh scan into the machine's file. Tools delete old transcripts (Claude Code after 30 days),
// so days missing from the scan are kept, and for each date+tool the side with more requests wins
// (a day whose logs were partly cleaned up must not shrink).
export function mergeRows(old, fresh) {
    const group = (rows) => {
        const m = new Map();
        for (const r of rows) {
            const k = `${r.date}|${r.tool}`;
            m.set(k, [...(m.get(k) ?? []), r]);
        }
        return m;
    };
    const o = group(old), f = group(fresh);
    const reqs = (rs = []) => rs.reduce((s, r) => s + r.requests, 0);
    const out = [];
    for (const k of new Set([...o.keys(), ...f.keys()]))
        out.push(...(reqs(f.get(k)) >= reqs(o.get(k)) ? f.get(k) : o.get(k)));
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model) || a.project.localeCompare(b.project));
}
// Plan-limit readings per machine (usage/<machine>.limits.json), synced like the usage rows so the
// dashboard on one Mac sees how close another Mac's plans are to their limits.
export function writeLimits(machine, limits, dir = usageDir()) {
    writeAtomic(join(dir, `${machine}.limits.json`), JSON.stringify(limits, null, 2) + "\n");
}
export const CLAUDE_LIMITS_SUFFIX = ".claude-limits.json";
export const claudeLimitsFile = (machine, dir = usageDir()) => join(dir, `${machine}${CLAUDE_LIMITS_SUFFIX}`);
export const claudeStateFile = (ax = AX) => join(ax, "state", "claude-limits.json");
// Aggregates only (FR-1): rebuilt field by field, so anything else that ever lands in the file is dropped on read.
export function parseClaudeLimits(raw) {
    const win = (w) => typeof w?.usedPercent === "number" && Number.isFinite(w.usedPercent)
        ? { usedPercent: w.usedPercent, ...(typeof w.resetsAt === "string" && !Number.isNaN(Date.parse(w.resetsAt)) ? { resetsAt: w.resetsAt } : {}) } : undefined;
    if (typeof raw?.asOf !== "string" || Number.isNaN(Date.parse(raw.asOf)))
        return null;
    const fiveHour = win(raw.fiveHour), sevenDay = win(raw.sevenDay);
    return fiveHour || sevenDay ? { asOf: raw.asOf, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } : null;
}
const readClaudeState = (file) => { try {
    return parseClaudeLimits(JSON.parse(readFileSync(file, "utf8")));
}
catch {
    return null;
} };
// Copy this Mac's latest reading into the synced usage folder (run by the scan, which `ax sync` runs before staging).
// A reading that says the same is left alone unless the copy is over an hour old, so the folder doesn't churn.
export function publishClaudeLimits(machine, dir = usageDir(), stateFile = claudeStateFile()) {
    const mine = readClaudeState(stateFile);
    if (!mine)
        return false;
    const file = claudeLimitsFile(machine, dir);
    const prev = readClaudeState(file);
    const body = (l) => JSON.stringify([l?.fiveHour, l?.sevenDay]);
    if (prev && body(prev) === body(mine) && Date.parse(mine.asOf) - Date.parse(prev.asOf) < 3600e3)
        return false;
    writeAtomic(file, JSON.stringify(mine, null, 2) + "\n");
    return true;
}
// { <machine>: { codex?: CodexLimits, claude?: ClaudeLimits } }. With the default folder, this Mac's own newer reading
// in state/ wins over the published copy, so the menu bar doesn't wait for the next scan.
export function readAllLimits(dir = usageDir(), localState = dir === usageDir() ? claudeStateFile() : null) {
    const out = {};
    if (existsSync(dir)) {
        const read = (f) => { try {
            return JSON.parse(readFileSync(join(dir, f), "utf8"));
        }
        catch {
            return undefined;
        } };
        const files = readdirSync(dir);
        for (const f of files.filter((f) => f.endsWith(".limits.json"))) {
            const v = read(f);
            if (v !== undefined)
                out[f.slice(0, -".limits.json".length)] = v;
        }
        for (const f of files.filter((f) => f.endsWith(CLAUDE_LIMITS_SUFFIX))) {
            const claude = parseClaudeLimits(read(f));
            if (claude) {
                const m = f.slice(0, -CLAUDE_LIMITS_SUFFIX.length);
                out[m] = { ...out[m], claude };
            }
        }
    }
    const mine = localState ? readClaudeState(localState) : null;
    if (mine) {
        const m = machineName();
        if (!out[m]?.claude || Date.parse(mine.asOf) > Date.parse(out[m].claude.asOf))
            out[m] = { ...out[m], claude: mine };
    }
    return out;
}
// Hour buckets for the menu bar (state/usage-hourly.json): local to this Mac, never synced.
export const hourlyFile = (ax = AX) => join(ax, "state", "usage-hourly.json");
export function writeHourly(h, file = hourlyFile()) {
    writeAtomic(file, JSON.stringify(h) + "\n");
}
export function readHourly(file = hourlyFile()) {
    try {
        const h = JSON.parse(readFileSync(file, "utf8"));
        return h && Array.isArray(h.buckets) ? h : null;
    }
    catch {
        return null;
    }
}
export function writeRows(file, rows) {
    writeAtomic(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}
