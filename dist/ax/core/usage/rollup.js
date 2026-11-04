import { costOf, priceFor } from "./pricing.js";
// Local calendar date (the Mac's timezone), matching how ccusage buckets days.
export const localDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const localHour = (d) => `${localDate(d.toISOString())}T${String(d.getHours()).padStart(2, "0")}`;
// The last `hours` hours in local-hour buckets per tool/billing/model, priced like rollup(), plus an exact
// total for the 10 minutes before `now` (the burn rate: hour buckets are too coarse for it).
export function hourly(events, book, machine, now, hours = 48) {
    const since = now.getTime() - hours * 3600e3, recent = now.getTime() - 10 * 60e3;
    const buckets = new Map();
    const last10m = { requests: 0, tokens: 0, costUsd: 0 };
    for (const e of events) {
        const t = Date.parse(e.ts);
        if (!e.ts || !(t >= since) || t > now.getTime())
            continue;
        const hour = localHour(new Date(t));
        const key = [hour, e.tool, e.billing ?? "", e.model].join("\u0000");
        let b = buckets.get(key);
        if (!b) {
            b = { hour, tool: e.tool, ...(e.billing ? { billing: e.billing } : {}), model: e.model, requests: 0, tokens: 0, costUsd: 0, _priced: false };
            buckets.set(key, b);
        }
        const tokens = e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h, inRecent = t > recent;
        b.requests += e.requests ?? 1;
        b.tokens += tokens;
        if (inRecent) {
            last10m.requests += e.requests ?? 1;
            last10m.tokens += tokens;
        }
        if (e.billing === "local") {
            b._priced = true;
            continue;
        }
        const p = priceFor(book, e.model, e.speed);
        if (p) {
            const c = costOf(p, e);
            b.costUsd = (b.costUsd ?? 0) + c;
            b._priced = true;
            if (inRecent)
                last10m.costUsd += c;
        }
    }
    return { machine, generatedAt: now.toISOString(), last10m: { ...last10m, costUsd: Math.round(last10m.costUsd * 1e4) / 1e4 }, buckets: [...buckets.values()]
            .map(({ _priced, ...b }) => ({ ...b, costUsd: _priced ? Math.round(b.costUsd * 1e4) / 1e4 : null }))
            .sort((a, b) => a.hour.localeCompare(b.hour) || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model)) };
}
// Collapse events into one row per date/tool/billing/plan/model/project. Cost is summed per event so
// fast-mode requests keep their own price; a row is null-cost only if none of its events had a price.
// Local models cost nothing, so they are priced at zero rather than looked up.
export function rollup(events, book, machine) {
    const rows = new Map();
    for (const e of events) {
        if (!e.ts)
            continue;
        const date = localDate(e.ts);
        const key = [date, e.tool, e.billing ?? "", e.planVia ?? "", e.model, e.project].join("\u0000");
        let r = rows.get(key);
        if (!r) {
            r = { date, machine, tool: e.tool, ...(e.billing ? { billing: e.billing } : {}), ...(e.planVia ? { planVia: e.planVia } : {}),
                model: e.model, project: e.project, requests: 0, sessions: 0,
                input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0, _sessions: new Set(), _priced: false };
            rows.set(key, r);
        }
        r.requests += e.requests ?? 1;
        r._sessions.add(e.session);
        r.input += e.input;
        r.output += e.output;
        r.cacheRead += e.cacheRead;
        r.cacheWrite5m += e.cacheWrite5m;
        r.cacheWrite1h += e.cacheWrite1h;
        if (e.billing === "local") {
            r._priced = true;
            continue;
        }
        const p = priceFor(book, e.model, e.speed);
        if (p) {
            r.costUsd = (r.costUsd ?? 0) + costOf(p, e);
            r._priced = true;
        }
    }
    return [...rows.values()]
        .map(({ _sessions, _priced, ...r }) => ({ ...r, sessions: _sessions.size, costUsd: _priced ? Math.round(r.costUsd * 1e4) / 1e4 : null }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model) || a.project.localeCompare(b.project));
}
