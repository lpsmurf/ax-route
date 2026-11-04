// Cross-tool delegate: sends one read-only task to a model over an OpenAI-compatible chat
// completions endpoint. Provider-independent by construction — Nebius Token Factory is the only
// configured default today, but `baseUrl`/`apiKey` are request fields, and the caller always
// supplies `model` (picked from evidence, Gate III; never defaulted here). The model gets exactly
// three tools, scoped to a project root (delegate-tools.ts): list, search, read. No shell, no
// writes, no other network access. Every run appends one aggregate ledger line — model, tokens,
// cost, latency, tool-call names only — never the task text or file content (Gate IX).
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultAllowedRoots, isAllowedRoot, runTool, TOOL_SPECS } from "./delegate-tools.js";
import { nebiusKey } from "./keys.js";
import { costOf, loadPriceBook, priceFor } from "../usage/pricing.js";
import { AX } from "../usage/store.js";
export { nebiusKey }; // re-exported so callers that imported it from delegate.ts (its original home) still work
export const DEFAULT_BASE_URL = "https://api.studio.nebius.com/v1";
export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TOOL_CALLS = 24;
export const MAX_TOOL_RESULT_CHARS = 80_000;
const DEFAULT_SYSTEM = "You are a read-only code assistant. Use the list/search/read tools to inspect the project before answering. "
    + "You cannot run shell commands, write files or reach the network beyond these tools. Answer concisely.";
async function callModel(baseUrl, apiKey, model, messages, fetchImpl, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages, tools: TOOL_SPECS, tool_choice: "auto" }),
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok)
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`invalid JSON response: ${text.slice(0, 300)}`);
        }
    }
    finally {
        clearTimeout(timer);
    }
}
// One aggregate line per run: no prompt, no task text, no tool arguments, no file content.
function writeLedger(dir, r) {
    try {
        mkdirSync(dir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const line = { at: new Date().toISOString(), model: r.model, turns: r.turns, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
            costUsd: r.costUsd, latencyMs: r.latencyMs, toolCalls: r.toolCalls.map((t) => t.name), ok: !r.error, error: r.error };
        appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(line)}\n`);
    }
    catch { /* ledger is best-effort; never fail the run over it */ }
}
export async function delegate(req) {
    const started = Date.now();
    const baseUrl = req.baseUrl ?? DEFAULT_BASE_URL;
    const maxTurns = Math.min(DEFAULT_MAX_TURNS, Math.max(1, Math.floor(req.maxTurns ?? DEFAULT_MAX_TURNS)));
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = req.fetchImpl ?? fetch;
    const ledgerDir = req.ledgerDir ?? join(AX, "state", "route", "ledger");
    const result = { answer: "", model: req.model, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0, toolCalls: [] };
    const apiKey = req.apiKey ?? nebiusKey();
    if (!apiKey) {
        result.error = "no Nebius API key (set NEBIUS_API_KEY or add it to Keychain as NEBIUS_API_KEY)";
        result.latencyMs = Date.now() - started;
        writeLedger(ledgerDir, result);
        return result;
    }
    if (!req.model) {
        result.error = "model is required (caller must pick it from evidence)";
        result.latencyMs = Date.now() - started;
        writeLedger(ledgerDir, result);
        return result;
    }
    let root;
    try {
        root = realpathSync(req.root);
    }
    catch {
        result.error = `project root not found: ${req.root}`;
        result.latencyMs = Date.now() - started;
        writeLedger(ledgerDir, result);
        return result;
    }
    const allowedRoots = req.allowedRoots ?? defaultAllowedRoots();
    if (!isAllowedRoot(root, allowedRoots)) {
        result.error = `project root not permitted: ${req.root} (must be AX itself or a registered AX/projects/* project)`;
        result.latencyMs = Date.now() - started;
        writeLedger(ledgerDir, result);
        return result;
    }
    const ctx = { root };
    const messages = [{ role: "system", content: req.system ?? DEFAULT_SYSTEM }, { role: "user", content: req.task }];
    let toolResultChars = 0;
    try {
        for (let turn = 0; turn < maxTurns; turn++) {
            result.turns = turn + 1;
            const body = await callModel(baseUrl, apiKey, req.model, messages, fetchImpl, timeoutMs);
            const usage = body.usage ?? {};
            result.inputTokens += usage.prompt_tokens ?? 0;
            result.outputTokens += usage.completion_tokens ?? 0;
            const msg = body.choices?.[0]?.message;
            if (!msg)
                throw new Error("no message in model response");
            messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
            if (!msg.tool_calls?.length) {
                result.answer = String(msg.content ?? "").trim();
                break;
            }
            for (const call of msg.tool_calls) {
                if (result.toolCalls.length >= MAX_TOOL_CALLS)
                    throw new Error(`stopped after ${MAX_TOOL_CALLS} tool calls`);
                const name = call.function?.name ?? "unknown";
                let output, ok = true;
                try {
                    output = runTool(ctx, name, JSON.parse(call.function?.arguments || "{}"));
                }
                catch (e) {
                    ok = false;
                    output = `error: ${e.message}`;
                }
                toolResultChars += output.length;
                if (toolResultChars > MAX_TOOL_RESULT_CHARS)
                    throw new Error(`stopped after ${MAX_TOOL_RESULT_CHARS} characters of tool output`);
                result.toolCalls.push({ name, ok });
                messages.push({ role: "tool", tool_call_id: call.id, name, content: output });
            }
            if (turn === maxTurns - 1 && !result.answer) {
                result.error = `stopped after ${maxTurns} turns without a final answer`;
                result.answer = String(msg.content ?? "").trim();
            }
        }
    }
    catch (e) {
        result.error = e.message;
    }
    const book = req.priceBook ?? loadPriceBookSafe();
    if (book) {
        const p = priceFor(book, req.model);
        if (p)
            result.costUsd = costOf(p, { input: result.inputTokens, output: result.outputTokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    }
    result.latencyMs = Date.now() - started;
    writeLedger(ledgerDir, result);
    return result;
}
function loadPriceBookSafe() {
    try {
        return loadPriceBook(join(AX, "config", "models.yaml"));
    }
    catch {
        return undefined;
    }
}
