#!/usr/bin/env node
// npx ax-route audit — public audit CLI for the generated ax-route mirror.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { audit, printAudit } from "./audit.js";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
export async function runAuditCli() {
    const sinceDays = flag("since") ? Number(flag("since")) : undefined;
    const result = audit({ home: flag("home"), sinceDays: sinceDays ? Number(sinceDays) : undefined, print: !has("json") });
    if (has("json")) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        printAudit(result);
    }
}
try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
        runAuditCli().catch((e) => { console.error(`! ${e.message}`); process.exitCode = 1; });
    }
}
catch {
    // argv[1] does not resolve to a real file; not the entry point
}
