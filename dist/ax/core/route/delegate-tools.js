// Read-only filesystem tools for the cross-tool delegate: list, search, read. Every path is
// resolved against the project root's realpath before use, so a `..` segment or a symlink that
// points outside the root is rejected rather than followed. No shell, no writes, no network here —
// this file only ever touches the local filesystem and only ever reads it. Anything that looks like
// a credential — by path (dotfiles, .git/, node_modules/, state/, memory/, key/cert/credential
// names) or by content (API keys, tokens, private-key blocks) — is either refused outright or
// scrubbed from tool output before it ever reaches the model (Gate IX).
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AX } from "../usage/store.js";
export const MAX_OUTPUT_CHARS = 20_000; // per tool call, keeps one turn small enough to re-send
export const MAX_READ_BYTES = 200_000; // refuse to load a huge file whole
export const MAX_LIST_ENTRIES = 500;
export const MAX_SEARCH_MATCHES = 200;
export const MAX_SEARCH_FILES = 2_000; // total files a single search() call may open
export const MAX_SEARCH_FILE_BYTES = 1_000_000; // skip an individual file above this size while scanning
export const MAX_SEARCH_TOTAL_BYTES = 5_000_000; // stop scanning once this many bytes have been read
export const MAX_SEARCH_MS = 3_000; // wall-clock budget for one search() call
const escapes = (root, resolved) => {
    const rel = relative(root, resolved);
    return rel === ".." || rel.startsWith(`..${sep}`);
};
// Resolves `p` (relative to `root`) and throws if the result — after following any symlink — lands
// outside `root`. A path that doesn't exist yet resolves against its nearest existing ancestor.
export function resolveInRoot(root, p) {
    const real = realpathSync(root);
    const candidate = join(real, p ?? ".");
    let resolved;
    try {
        resolved = realpathSync(candidate);
    }
    catch {
        resolved = candidate;
    } // may not exist; callers stat() right after and get a clean error
    if (escapes(real, resolved))
        throw new Error(`path escapes project root: ${p}`);
    return resolved;
}
// --------------------------------------------------------------- allowed roots (no arbitrary root)
// A delegate root must be AX itself or a currently registered project under AX/projects — never an
// arbitrary path the caller happens to name. `ax/cli/ax` populates AX/projects from config/projects.tsv
// (some entries are symlinks to clones elsewhere), so this reads the registry fresh each time rather
// than caching it, and always compares realpaths so a symlink can't be used to sneak in a different root.
export function defaultAllowedRoots(ax = AX) {
    const candidates = [ax];
    try {
        for (const name of readdirSync(join(ax, "projects")))
            candidates.push(join(ax, "projects", name));
    }
    catch { /* no projects registered yet */ }
    const roots = [];
    for (const c of candidates) {
        try {
            roots.push(realpathSync(c));
        }
        catch { /* dangling entry, skip */ }
    }
    return roots;
}
export function isAllowedRoot(root, allowedRoots) {
    try {
        const candidate = realpathSync(root);
        return allowedRoots.some((allowed) => { try {
            return realpathSync(allowed) === candidate;
        }
        catch {
            return false;
        } });
    }
    catch {
        return false;
    }
}
// --------------------------------------------------------------- sensitive-path blocklist
// Anything a path segment matches here is refused for read/search and hidden from list — dotfiles
// (.env*, .git, .ssh, .npmrc, .netrc, …), the harness's own state/memory, node_modules, and anything
// whose name says key/cert/credential/secret even when it isn't a dotfile (e.g. `secrets.yaml`,
// `id_rsa`, `service-account.pem`).
const BLOCKED_DIR_NAMES = new Set(["node_modules", "state", "memory"]);
const SECRET_NAME_RE = /(^|[._-])(key|cert|certificate|credentials?|secrets?)([._-]|$)/i;
const SECRET_EXT_RE = /\.(pem|key|crt|cer|der|p12|pfx|jks|keystore|env)$/i;
const SSH_KEY_RE = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/;
export function isSensitiveName(name) {
    const lower = name.toLowerCase();
    return lower.startsWith(".") || BLOCKED_DIR_NAMES.has(lower) || SECRET_NAME_RE.test(lower)
        || SECRET_EXT_RE.test(lower) || SSH_KEY_RE.test(lower);
}
// Every path segment between `root` and `full`, checked individually so `src/state/x.ts` (a
// legitimate subfolder name) is still blocked once it contains a `state` segment, same as a
// top-level one.
function hasSensitiveSegment(root, full) {
    return relative(root, full).split(sep).some((seg) => seg && isSensitiveName(seg));
}
// --------------------------------------------------------------- output scrubbing (Gate IX)
// Applied to every byte of file content or search output before it is handed back as a tool result —
// scanning a non-blocked file that happens to contain a hardcoded key must not leak it to the model.
const SECRET_PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /["']?[A-Za-z0-9_-]*(?:secret|token|password|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?[^\s"'#]{6,}["']?/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
    /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    /\bAIza[A-Za-z0-9_-]{35}\b/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\bv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/g, // Nebius Token Factory key shape
];
export function scrub(text) {
    let out = text;
    for (const re of SECRET_PATTERNS)
        out = out.replace(re, "[REDACTED]");
    return out;
}
const finalize = (s) => {
    const scrubbed = scrub(s);
    return scrubbed.length > MAX_OUTPUT_CHARS ? `${scrubbed.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated at ${MAX_OUTPUT_CHARS} chars)` : scrubbed;
};
function isProbablyBinary(buf) {
    const len = Math.min(buf.length, 8_000);
    for (let i = 0; i < len; i++)
        if (buf[i] === 0)
            return true;
    return false;
}
export function listDir(ctx, path = ".") {
    const dir = resolveInRoot(ctx.root, path);
    const root = realpathSync(ctx.root);
    if (hasSensitiveSegment(root, dir))
        throw new Error(`refusing to list a sensitive path: ${path}`);
    const st = statSync(dir);
    if (!st.isDirectory())
        throw new Error(`not a directory: ${path}`);
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !isSensitiveName(e.name))
        .slice(0, MAX_LIST_ENTRIES)
        .map((e) => `${e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "f"} ${e.name}`);
    return finalize(entries.join("\n") || "(empty)");
}
export function readFile(ctx, path, maxBytes = MAX_READ_BYTES) {
    if (!path)
        throw new Error("read: path is required");
    const file = resolveInRoot(ctx.root, path);
    const root = realpathSync(ctx.root);
    if (hasSensitiveSegment(root, file))
        throw new Error(`refusing to read a sensitive path: ${path}`);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
        fd = openSync(file, constants.O_RDONLY | noFollow);
        const st = fstatSync(fd);
        if (!st.isFile())
            throw new Error(`not a file: ${path}`);
        if (st.size > maxBytes)
            throw new Error(`file too large (${st.size}b > ${maxBytes}b): ${path}`);
        const buf = readFileSync(fd);
        if (isProbablyBinary(buf))
            throw new Error(`binary file, refusing to read as text: ${path}`);
        return finalize(buf.toString("utf8"));
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
// Fixed-string (literal, case-sensitive) search across text files under `path` — never a regex, so
// an untrusted pattern from the model can't build a catastrophic-backtracking or otherwise expensive
// expression. Never follows symlinks while walking (each entry is checked with dirent flags before
// recursing), so a symlinked directory can't be used to walk out of the root even though
// `resolveInRoot` already caught the starting path. Bounded by file count, total bytes and wall time
// as well as MAX_SEARCH_MATCHES, so a huge or adversarial tree can't turn one tool call into a scan
// of the whole disk.
export function searchFiles(ctx, pattern, path = ".") {
    if (!pattern)
        throw new Error("search: pattern is required");
    const start = resolveInRoot(ctx.root, path);
    const root = realpathSync(ctx.root);
    if (hasSensitiveSegment(root, start))
        throw new Error(`refusing to search a sensitive path: ${path}`);
    const hits = [];
    const deadline = Date.now() + MAX_SEARCH_MS;
    let filesScanned = 0, bytesScanned = 0, stopped = false;
    const walk = (dir) => {
        if (hits.length >= MAX_SEARCH_MATCHES || stopped)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (hits.length >= MAX_SEARCH_MATCHES || stopped)
                return;
            if (isSensitiveName(e.name) || e.isSymbolicLink())
                continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                walk(full);
                continue;
            }
            if (!e.isFile())
                continue;
            if (Date.now() > deadline || filesScanned >= MAX_SEARCH_FILES || bytesScanned >= MAX_SEARCH_TOTAL_BYTES) {
                stopped = true;
                return;
            }
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.size > MAX_SEARCH_FILE_BYTES)
                continue; // skip oversized file, keep scanning the rest
            let buf;
            try {
                buf = readFileSync(full);
            }
            catch {
                continue;
            } // unreadable, skip
            if (isProbablyBinary(buf))
                continue;
            filesScanned++;
            bytesScanned += buf.length;
            const lines = buf.toString("utf8").split("\n");
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_MATCHES; i++) {
                if (lines[i].includes(pattern))
                    hits.push(`${relative(root, full)}:${i + 1}: ${lines[i].slice(0, 200)}`);
            }
        }
    };
    walk(start);
    const body = hits.length ? hits.join("\n") : "(no matches)";
    return finalize(stopped ? `${body}\n…(search stopped early: file/byte/time cap reached)` : body);
}
// OpenAI-compatible tool specs, sent verbatim in the `tools` field of a chat completion request.
export const TOOL_SPECS = [
    { type: "function", function: { name: "list", description: "List files and directories under a path, relative to the project root.",
            parameters: { type: "object", properties: { path: { type: "string", description: 'Relative path, defaults to "."' } } } } },
    { type: "function", function: { name: "search", description: "Fixed-string (literal, case-sensitive) search across text files under a path, relative to the project root. Not a regex.",
            parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: 'Relative path, defaults to "."' } }, required: ["pattern"] } } },
    { type: "function", function: { name: "read", description: "Read a text file's contents, relative to the project root.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];
export const TOOL_NAMES = TOOL_SPECS.map((t) => t.function.name);
// Dispatches one tool call by name. Throws on an unknown tool or bad arguments — the caller (the
// delegate loop) turns that into a tool-result error message rather than failing the whole run.
export function runTool(ctx, name, args) {
    switch (name) {
        case "list": return listDir(ctx, typeof args.path === "string" ? args.path : ".");
        case "search": return searchFiles(ctx, typeof args.pattern === "string" ? args.pattern : "", typeof args.path === "string" ? args.path : ".");
        case "read": return readFile(ctx, typeof args.path === "string" ? args.path : "");
        default: throw new Error(`unknown tool: ${name}`);
    }
}
