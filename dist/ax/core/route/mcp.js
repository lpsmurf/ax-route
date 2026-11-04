// MCP stdio adapter for the cross-tool delegate: newline-delimited JSON-RPC 2.0 over stdin/stdout,
// no dependency beyond node builtins. Exposes one tool, `delegate`, so any MCP client (Claude Code,
// Codex, etc.) can hand a read-only task to a Nebius model without that model ever seeing the
// caller's own credentials or writing to the caller's filesystem — see delegate.ts for the guardrails.
// The model to use is resolved here from evidence.ts for the given `job`, same as `ax route delegate`
// (cli.ts) — a caller never gets to guess a model; `model` is only honored as an explicit,
// clearly-marked override of evidence-based routing, and an untested job with no override is refused.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { delegate } from "./delegate.js";
import { evidenceForJob } from "./evidence.js";
const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";
const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 8;
const TOOL_DEFINITION = Object.freeze({
    name: "delegate",
    description: "Delegate a read-only inspection task to another model with list/search/read tools scoped to a project root. No shell, no writes, no other network access.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["job", "task", "root"],
        properties: {
            job: { type: "string", description: "Job name; the model is chosen from this job's bench evidence unless model is set." },
            task: { type: "string", description: "What to find out." },
            root: { type: "string", description: "Absolute project root; tools cannot read outside it." },
            model: { type: "string", description: "Explicit model override — bypasses evidence-based routing. Only set this if there is a clear, stated reason the evidence-selected model won't do." },
            maxTurns: { type: "number", description: `Clamped to [${MIN_MAX_TURNS}, ${MAX_MAX_TURNS}].` },
        },
    },
});
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function jsonRpcResult(id, result) { return { jsonrpc: JSONRPC_VERSION, id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message } }; }
// `delegateFn` and `evidenceFn` are injectable so tests never make a real network call or need
// committed bench results.
export function createDelegateMcpService(delegateFn = delegate, evidenceFn = evidenceForJob) {
    let initialized = false;
    return {
        async handle(message) {
            if (!isRecord(message) || message.jsonrpc !== JSONRPC_VERSION || typeof message.method !== "string") {
                return jsonRpcError(isRecord(message) ? message.id : null, -32600, "Invalid JSON-RPC request.");
            }
            const hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== undefined;
            if (!hasId) {
                if (message.method === "notifications/initialized")
                    initialized = true;
                return null; // notifications get no reply
            }
            if (message.method === "initialize") {
                return jsonRpcResult(message.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "ax-route-delegate", version: "1.0.0" },
                    instructions: "delegate() is read-only: it cannot run shell commands, write files, or reach the network beyond the project it is given.",
                });
            }
            if (!initialized && message.method !== "ping") {
                // Be lenient: some clients call tools/list before sending notifications/initialized.
                initialized = true;
            }
            if (message.method === "ping")
                return jsonRpcResult(message.id, {});
            if (message.method === "tools/list")
                return jsonRpcResult(message.id, { tools: [TOOL_DEFINITION] });
            if (message.method === "tools/call") {
                const params = message.params;
                if (!isRecord(params) || params.name !== "delegate" || !isRecord(params.arguments)) {
                    return jsonRpcError(message.id, -32602, "Unknown tool or missing arguments.");
                }
                const a = params.arguments;
                if (typeof a.job !== "string" || typeof a.task !== "string" || typeof a.root !== "string") {
                    return jsonRpcError(message.id, -32602, "delegate requires job, task and root strings.");
                }
                const override = typeof a.model === "string" && a.model.trim() ? a.model : undefined;
                try {
                    const model = override ?? evidenceFn(a.job).choice?.model;
                    if (!model) {
                        return jsonRpcError(message.id, -32602, `no evidence-selected model for job "${a.job}" (untested — no result cleared the bar). Pass an explicit model override.`);
                    }
                    const maxTurns = typeof a.maxTurns === "number" ? Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.floor(a.maxTurns))) : undefined;
                    const r = await delegateFn({ model, task: a.task, root: a.root, maxTurns });
                    const text = r.error && !r.answer ? `error: ${r.error}` : r.answer;
                    return jsonRpcResult(message.id, {
                        content: [{ type: "text", text }],
                        isError: Boolean(r.error && !r.answer),
                        // Usage/cost/latency/model as structured metadata, never the task text or file content.
                        _meta: { model: r.model, turns: r.turns, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, latencyMs: r.latencyMs },
                    });
                }
                catch (e) {
                    return jsonRpcError(message.id, -32603, `delegate failed: ${e.message}`);
                }
            }
            return jsonRpcError(message.id, -32601, `Method not found: ${message.method}.`);
        },
    };
}
// Reads newline-delimited JSON-RPC from `input`, writes replies to `output`. One line = one message;
// malformed lines get a JSON-RPC parse error instead of crashing the process.
export function runStdioServer(service, input = process.stdin, output = process.stdout) {
    const rl = createInterface({ input, terminal: false });
    rl.on("line", (raw) => {
        const line = raw.trim();
        if (!line)
            return;
        void (async () => {
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Invalid JSON."))}\n`);
                return;
            }
            const reply = await service.handle(message);
            if (reply)
                output.write(`${JSON.stringify(reply)}\n`);
        })();
    });
}
// `node ax/core/route/mcp.ts` starts the stdio server directly; imported as a module it does nothing.
// Compares realpaths (via pathToFileURL) rather than raw strings so this still matches when argv[1]
// is a symlink — e.g. `~/.local/bin/ax` → `ax/cli/ax` invoking this file through another symlinked path.
if (process.argv[1]) {
    try {
        if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
            runStdioServer(createDelegateMcpService());
    }
    catch { /* argv[1] doesn't resolve to a real file; not being run as the entrypoint */ }
}
