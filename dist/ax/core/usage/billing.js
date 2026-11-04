// Model-agnostic agents (Hermes, OpenClaw) often ride another tool's plan. Name that plan, so its
// value and rate limits are counted once, against the plan that actually pays for them.
export function planFrom(...hints) {
    const s = hints.filter((h) => typeof h === "string").join(" ");
    if (/api\.kimi\.com\/coding|kimi-code/i.test(s))
        return "kimi";
    if (/chatgpt\.com\/backend-api|codex/i.test(s))
        return "codex";
    return undefined;
}
// Endpoints on the operator's own machine are free; endpoints that only serve flat-fee plans are a subscription.
export function billingFromUrl(url) {
    const u = typeof url === "string" ? url : "";
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(u))
        return "local";
    if (planFrom(u))
        return "subscription";
    return undefined;
}
