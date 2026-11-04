// Public audit entry point for the generated ax-route mirror.
// Reads the same local agent-tool logs as `ax usage`, prices them with the bundled public price book,
// and prints a summary. Nothing is uploaded; prompts and session text are never read.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaude } from "../usage/claude.js";
import { scanCodex } from "../usage/codex.js";
import { parseHermes } from "../usage/hermes.js";
import { parseKimi, parseKimiV1 } from "../usage/kimi.js";
import { parseOpenclaw } from "../usage/openclaw.js";
import { loadPriceBook } from "../usage/pricing.js";
import { rollup, localDate } from "../usage/rollup.js";
const toolOrder = ["claude", "codex", "kimi", "hermes", "openclaw"];
function collectEvents(home) {
    const codex = scanCodex(join(home, ".codex", "sessions"));
    return [
        ...parseClaude(join(home, ".claude", "projects"), join(home, ".claude.json")),
        ...codex.events,
        ...parseKimi(join(home, ".kimi-code", "sessions")),
        ...parseKimiV1(join(home, ".kimi")),
        ...parseHermes(join(process.env.HERMES_HOME ?? join(home, ".hermes"), "state.db")),
        ...parseOpenclaw(join(process.env.OPENCLAW_STATE_DIR ?? join(home, ".openclaw"))),
    ];
}
function defaultConfigRoot() {
    // In the published package, this file is dist/ax/core/route/audit.js. path.join treats
    // the file itself as the first segment, so we need five `..` to reach the package root:
    // audit.js -> route -> core -> ax -> dist -> root.
    const here = fileURLToPath(import.meta.url);
    return join(here, "..", "..", "..", "..", "..", "config");
}
export function audit(o = {}) {
    const home = o.home ?? homedir();
    const configRoot = o.configRoot ?? defaultConfigRoot();
    const book = loadPriceBook(join(configRoot, "models.yaml"));
    const events = collectEvents(home);
    const rows = rollup(events, book, "mirror");
    const since = localDate(new Date(Date.now() - (o.sinceDays ?? 30) * 864e5).toISOString());
    const groups = new Map();
    function add(key, r) {
        const tokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
        const g = groups.get(key) ?? { tool: key, requests: 0, tokens: 0, costUsd: 0, unpricedTokens: 0, billing: r.billing ?? "unknown" };
        g.requests += r.requests;
        g.tokens += tokens;
        if (r.costUsd === null)
            g.unpricedTokens += tokens;
        else
            g.costUsd += r.costUsd;
        g.costUsd = Math.round(g.costUsd * 10000) / 10000;
        groups.set(key, g);
    }
    // Only the window counts toward the totals; older rows still mark a tool as found (with zeros) below.
    for (const r of rows)
        if (r.date >= since)
            add(r.tool, r);
    for (const e of events) {
        if (groups.has(e.tool))
            continue;
        add(e.tool, { date: since, machine: "mirror", tool: e.tool, model: e.model, project: "unknown", requests: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0, billing: e.billing });
    }
    const tools = [...groups.values()].sort((a, b) => {
        const ai = toolOrder.indexOf(a.tool);
        const bi = toolOrder.indexOf(b.tool);
        if (ai >= 0 && bi >= 0)
            return ai - bi;
        if (ai >= 0)
            return -1;
        if (bi >= 0)
            return 1;
        return a.tool.localeCompare(b.tool);
    });
    return { generatedAt: new Date().toISOString(), home, sources: events.length, rows: rows.length, since, tools };
}
function fmtUsd(n) {
    if (Math.abs(n) >= 1000)
        return `$${Math.round(n).toLocaleString("en-US")}`;
    return `$${n.toFixed(2)}`;
}
function fmtTok(n) {
    if (n >= 1e9)
        return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}
export function printAudit(result) {
    const sourceCounts = new Map();
    for (const t of result.tools)
        sourceCounts.set(t.tool, t.requests);
    const sourceLine = toolOrder
        .map((t) => `${t} ${sourceCounts.get(t) ?? 0}`)
        .join(" · ");
    console.log(`sources: ${sourceLine}`);
    if (result.sources === 0) {
        console.log("\nno agent usage found on this machine. ax-route reads Claude Code, Codex, Kimi Code, Hermes and OpenClaw logs.");
        return;
    }
    const totalRequests = result.tools.reduce((s, t) => s + t.requests, 0);
    console.log(`usage:   ${totalRequests.toLocaleString("en-US")} requests since ${result.since}`);
    console.log("cost:    API-equivalent (usage priced at API rates), not what you paid\n");
    console.log("tool".padEnd(12), "requests".padStart(9), "tokens".padStart(10), "API-eq $".padStart(10), "unpriced".padStart(10));
    for (const t of result.tools) {
        console.log(t.tool.padEnd(12), String(t.requests).padStart(9), fmtTok(t.tokens).padStart(10), fmtUsd(t.costUsd).padStart(10), (t.unpricedTokens ? fmtTok(t.unpricedTokens) : "-").padStart(10));
    }
    const totalCost = result.tools.reduce((s, t) => s + t.costUsd, 0);
    const totalUnpriced = result.tools.reduce((s, t) => s + t.unpricedTokens, 0);
    console.log("—".repeat(12).padStart(12), "—".repeat(9).padStart(9), "—".repeat(10).padStart(10), "—".repeat(10).padStart(10), "—".repeat(10).padStart(10));
    console.log("total".padEnd(12), String(totalRequests).padStart(9), "".padStart(10), fmtUsd(totalCost).padStart(10), (totalUnpriced ? fmtTok(totalUnpriced) : "-").padStart(10));
}
