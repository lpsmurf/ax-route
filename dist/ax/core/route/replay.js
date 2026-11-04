// Turns bench evidence into a spend scenario: what recent usage would have cost if the mechanical
// share of matching rows had gone to their evidence-derived cheapest capable model instead. This
// never changes what was actually spent — it is always a scenario, shown as one (ax-route
// src/replay.mjs; spec 003 "Savings" section, `ax usage --savings`).
import { costOf, priceFor } from "../usage/pricing.js";
import { boundedShareFromIo } from "../density/density.js";
import { jevPricePerMTok } from "../density/jev-price.js";
const r2 = (n) => Math.round(n * 100) / 100;
export function replay(o) {
    const lines = o.routes.map((route) => {
        const price = priceFor(o.book, route.choice.model);
        const rows = o.rows.filter((r) => r.date >= o.since && route.matchesRow(r));
        let actualUsd = 0;
        let withRouteUsd = 0;
        let requests = 0;
        for (const r of rows) {
            const actual = r.costUsd ?? 0;
            const routedCost = price ? costOf(price, r) : actual;
            // Only ever move the cheaper direction: routing never costs more than the row already did.
            const moved = Math.max(0, actual - routedCost) * route.share;
            actualUsd += actual;
            withRouteUsd += actual - moved;
            requests += r.requests;
        }
        return { job: route.job, model: route.choice.model, requests, actualUsd: r2(actualUsd), withRouteUsd: r2(withRouteUsd), savingUsd: r2(actualUsd - withRouteUsd) };
    });
    const actualUsd = r2(lines.reduce((s, l) => s + l.actualUsd, 0));
    const withRouteUsd = r2(lines.reduce((s, l) => s + l.withRouteUsd, 0));
    return {
        since: o.since,
        lines,
        actualUsd,
        withRouteUsd,
        savingUsd: r2(actualUsd - withRouteUsd),
        savingPct: actualUsd ? Math.round(((actualUsd - withRouteUsd) / actualUsd) * 1000) / 10 : 0,
    };
}
const rowTokens = (r) => r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
export function savings(o) {
    const inWindow = o.rows.filter((r) => r.date >= o.since && r.billing !== "local");
    const models = [...new Set(inWindow.map((r) => r.model))];
    const byModel = models.map((model) => {
        const rows = inWindow.filter((r) => r.model === model);
        const res = o.routing
            ? replay({ rows, since: o.since, book: o.book, routes: [{ job: "mechanical", matchesRow: () => true, choice: { job: "mechanical", model: o.routing.model, passRate: 0, costPerTaskUsd: 0, samples: 0, evidence: o.routing.evidence ?? "" }, share: o.routing.share }] })
            : null;
        const actualUsd = res ? res.actualUsd : r2(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0));
        const counterfactualUsd = res ? res.withRouteUsd : actualUsd;
        return {
            model, requests: rows.reduce((s, r) => s + r.requests, 0), tokens: rows.reduce((s, r) => s + rowTokens(r), 0),
            unpricedTokens: rows.filter((r) => r.costUsd === null).reduce((s, r) => s + rowTokens(r), 0),
            actualUsd, counterfactualUsd, deltaUsd: r2(actualUsd - counterfactualUsd),
        };
    }).sort((a, b) => b.actualUsd - a.actualUsd || a.model.localeCompare(b.model));
    const totalUsd = r2(byModel.reduce((s, l) => s + l.actualUsd, 0));
    const counterfactualUsd = r2(byModel.reduce((s, l) => s + l.counterfactualUsd, 0));
    // Jev scenario: bounded share from non-cache tokens (input + output) per request. Total tokens include cache reads,
    // which pin Claude Code sessions at the heuristic's floor.
    const jevPricePerMTokUsd = jevPricePerMTok(o.book);
    // Priced rows only, so the tokens match the dollars they are compared with.
    const priced = inWindow.filter((r) => r.costUsd !== null);
    const ioTokens = priced.reduce((s, r) => s + r.input + r.output, 0);
    const totalRequests = priced.reduce((s, r) => s + r.requests, 0);
    const boundedShare = boundedShareFromIo(ioTokens, totalRequests);
    const jevComparison = boundedShare === null ? null : (() => {
        const jevCostUsd = r2(ioTokens * boundedShare * jevPricePerMTokUsd / 1e6);
        const currentBoundedCostUsd = r2(totalUsd * boundedShare);
        return { basis: "scenario", jevPricePerMTokUsd, boundedShareEstimate: Math.round(boundedShare * 100) / 100, jevCostUsd, currentBoundedCostUsd,
            jevSavingUsd: r2(Math.max(0, currentBoundedCostUsd - jevCostUsd)) };
    })();
    return {
        since: o.since, routing: o.routing, totalUsd, counterfactualUsd, deltaUsd: r2(totalUsd - counterfactualUsd),
        deltaPct: totalUsd ? Math.round(((totalUsd - counterfactualUsd) / totalUsd) * 1000) / 10 : 0,
        unpricedTokens: byModel.reduce((s, l) => s + l.unpricedTokens, 0), byModel,
        jevComparison,
    };
}
