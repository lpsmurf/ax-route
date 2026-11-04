// Decision Density Audit (inspired by the TypeSafe Jev article's thesis):
// "Most agent bills aren't expensive because the work is hard. They're expensive because
// four out of five steps were never asked to be cheap."
//
// Classifies session steps into bounded decisions (yes/no, pick-from-list, gate/approve)
// vs generative work (writing code, prose, plans). The ratio is the "decision density" —
// a session with high density has many steps that could run through a classifier (like Jev)
// instead of a full generative model. The Jev opportunity is a SCENARIO, not spend: the $ that
// would be saved if those steps had gone through Jev (price from config/models.yaml via
// jev-price.ts) instead of the model that ran them, at API-equivalent prices.
//
// Pure function over session metadata — no message text ever leaves the Mac.
// Patterns that indicate a bounded decision (yes/no, approval, routing, classification).
const BOUNDED_PATTERNS = [
    [/\b(approv\w*|confirm\w*|accept\w*|reject\w*|deny|dismiss\w*)\b/i, "approval gate"],
    [/\b(is_safe|safe\b|safety|guard|gate|block\w*|allow\w*)\b/i, "safety gate"],
    [/\b(classif\w*|categoriz\w*|triage\w*|sort\w*|route\w*|assign\w*)\b/i, "classification/routing"],
    [/\b(yes|no|true|false|pass|fail|ok|skip)\b/i, "binary decision"],
    [/\b(pick\w*|choos\w*|choose|select\w*|which)\b/i, "selection from options"],
    [/\b(urgent|priority|severity|level)\b/i, "priority scoring"],
    [/\b(valid\w*|invalid\w*|match\w*|mismatch\w*|correct\w*|incorrect\w*)\b/i, "validation check"],
];
// Tool calls that are inherently bounded decisions (the tool either runs or doesn't).
const BOUNDED_TOOLS = new Set([
    "Bash", "bash", "shell", "exec", "execute",
    "Read", "read", "Glob", "glob", "Grep", "grep",
    "search", "web_search", "WebSearch",
]);
// Tool calls that are generative (produce open-ended text or code).
const GENERATIVE_TOOLS = new Set([
    "Edit", "edit", "Write", "write", "MultiEdit",
    "create_file", "replace_file", "insert_text",
]);
export function classifyToolCall(name, _summary) {
    if (BOUNDED_TOOLS.has(name))
        return { kind: "bounded", reason: `tool call: ${name} (read/execute gate)` };
    if (GENERATIVE_TOOLS.has(name))
        return { kind: "generative", reason: `tool call: ${name} (open-ended output)` };
    // Unknown tools: assume bounded (most tool calls are execute-or-not decisions).
    return { kind: "bounded", reason: `tool call: ${name} (assumed bounded)` };
}
export function classifyText(text) {
    for (const [re, reason] of BOUNDED_PATTERNS) {
        if (re.test(text))
            return { kind: "bounded", reason };
    }
    // Default: generative (writing prose/code/plans).
    return { kind: "generative", reason: "open-ended text generation" };
}
// Heuristic share of steps that are bounded decisions, from non-cache tokens per request:
// short exchanges are decisions, long ones are generation. Clamped to 10-80%.
// Returns null when it cannot be estimated (no requests, or no token count).
export function boundedShareFromIo(ioTokens, requests) {
    if (!(requests > 0) || ioTokens === undefined || !Number.isFinite(ioTokens) || ioTokens < 0)
        return null;
    return Math.max(0.1, Math.min(0.8, 1 - ioTokens / requests / 5000));
}
const r2 = (n) => Math.round(n * 100) / 100;
// Estimate density from session metadata. With tool-call data each call is classified; without it the share
// comes from boundedShareFromIo. Returns null for a session that cannot be estimated (0 requests, or no
// non-cache token count): such sessions are left out of the report instead of reporting a made-up share.
export function estimateDensity(s, jevPricePerMTok) {
    const share = boundedShareFromIo(s.ioTokens, s.requests);
    if (share === null)
        return null;
    const jevPerToken = jevPricePerMTok / 1_000_000;
    const io = s.ioTokens;
    let totalSteps, boundedSteps, density;
    if (s.toolCalls?.length) {
        // We have actual tool-call data — classify each one. Each request that isn't a tool call is a generative text step.
        const bounded = s.toolCalls.filter((t) => classifyToolCall(t.name, t.summary).kind === "bounded").length;
        totalSteps = s.toolCalls.length + Math.max(0, s.requests - s.toolCalls.length);
        boundedSteps = bounded;
        density = boundedSteps / totalSteps;
    }
    else {
        totalSteps = s.requests;
        boundedSteps = Math.round(s.requests * share);
        density = share;
    }
    const boundedShare = totalSteps ? boundedSteps / totalSteps : 0;
    const jevCostUsd = r2(io * boundedShare * jevPerToken);
    const currentCostUsd = r2(s.costUsd * boundedShare);
    return { id: s.id, totalSteps, boundedSteps, generativeSteps: totalSteps - boundedSteps, density: r2(density),
        jevOpportunityUsd: r2(Math.max(0, currentCostUsd - jevCostUsd)), jevCostUsd, currentCostUsd };
}
export const TOP_SESSIONS = 20;
export function densityReport(sessions, jevPricePerMTok) {
    const all = sessions.map((s) => estimateDensity(s, jevPricePerMTok)).filter((d) => d !== null);
    const sum = (f) => all.reduce((t, d) => t + f(d), 0);
    return {
        basis: "scenario", jevPricePerMTokUsd: jevPricePerMTok,
        sessions: all.length, excludedSessions: sessions.length - all.length,
        totalSteps: sum((d) => d.totalSteps), boundedSteps: sum((d) => d.boundedSteps), generativeSteps: sum((d) => d.generativeSteps),
        avgDensity: all.length ? r2(sum((d) => d.density) / all.length) : 0,
        totalJevOpportunityUsd: r2(sum((d) => d.jevOpportunityUsd)),
        totalJevCostUsd: r2(sum((d) => d.jevCostUsd)),
        totalCurrentCostUsd: r2(sum((d) => d.currentCostUsd)),
        bySession: all.sort((a, b) => b.jevOpportunityUsd - a.jevOpportunityUsd).slice(0, TOP_SESSIONS),
    };
}
