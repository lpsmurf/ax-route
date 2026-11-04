import { readdirSync, statSync, readFileSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
// Recursively list files under dir whose name matches test. Missing dirs yield nothing.
export function findFiles(dir, test) {
    const out = [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        const p = join(dir, name);
        let st;
        try {
            st = statSync(p);
        }
        catch {
            continue;
        }
        if (st.isDirectory())
            out.push(...findFiles(p, test));
        else if (test(name))
            out.push(p);
    }
    return out;
}
// Parse a JSONL file, skipping blank or malformed lines (logs can be cut off mid-write).
export function* jsonl(file) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line)
            continue;
        try {
            yield JSON.parse(line);
        }
        catch { /* partial line */ }
    }
}
// Same lines as jsonl(), but read without blocking and handed to the caller in slices: the event loop gets a turn
// every `sliceEvery` records, so scanning a 30 MB transcript never freezes the server.
export async function* jsonlAsync(file, sliceEvery = 2000) {
    const text = await readFile(file, "utf8");
    let pos = 0, n = 0;
    while (pos < text.length) {
        let end = text.indexOf("\n", pos);
        if (end < 0)
            end = text.length;
        const line = text.slice(pos, end);
        pos = end + 1;
        if (!line)
            continue;
        let rec, ok = true;
        try {
            rec = JSON.parse(line);
        }
        catch {
            ok = false; /* partial line */
        }
        if (ok)
            yield rec;
        if (++n % sliceEvery === 0)
            await new Promise((r) => setImmediate(r));
    }
}
// Harness project links (~/dev/projects/<name> -> real clone) as realpath -> name.
let harnessProjects;
function harnessMap(home) {
    if (harnessProjects)
        return harnessProjects;
    harnessProjects = new Map();
    const dir = join(process.env.AX_HOME ?? join(home, "dev"), "projects");
    try {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            try {
                if (lstatSync(p).isSymbolicLink() || statSync(p).isDirectory())
                    harnessProjects.set(realpathSync(p), name);
            }
            catch { /* broken link */ }
        }
    }
    catch { /* no harness */ }
    return harnessProjects;
}
// Map a working directory to a project name: a harness project if the path is inside one, else the
// outermost git repo below $HOME (so nested clones count toward the repo you were working in), else
// the folder name. Paths that no longer exist fall back to the first folder below $HOME.
const projectCache = new Map();
export function projectOf(cwd, home = homedir()) {
    if (typeof cwd !== "string" || !cwd)
        return "unknown";
    const hit = projectCache.get(cwd);
    if (hit)
        return hit;
    let name;
    let real = cwd;
    try {
        real = realpathSync(cwd);
    }
    catch { /* deleted folder */ }
    for (const [root, n] of harnessMap(home))
        if (real === root || real.startsWith(root + "/")) {
            name = n;
            break;
        }
    if (!name) {
        if (real === home || cwd === home)
            name = "home";
        else if (!real.startsWith(home + "/"))
            name = "other";
        else {
            let outer;
            for (let d = real; d.startsWith(home + "/"); d = dirname(d))
                if (existsSync(join(d, ".git")))
                    outer = d;
            name = basename(outer ?? join(home, real.slice(home.length + 1).split("/")[0]));
        }
    }
    projectCache.set(cwd, name);
    return name;
}
export const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
