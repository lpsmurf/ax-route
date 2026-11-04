// Nebius Token Factory key: env NEBIUS_API_KEY, else macOS Keychain item "NEBIUS_API_KEY" (read by
// name, never logged; same pattern as judge/judges.ts typesafeKey). A valid key is ~236 chars, two
// dot-separated parts after "v1." — a truncated paste (128 chars, seen once) still "reads" fine but
// returns 401 on every call, so the shape is checked here rather than debugged later as a network
// problem (vault fact: Nebius key shape, 2026-09-24).
import { execFileSync } from "node:child_process";
const MIN_KEY_LENGTH = 200;
export function nebiusKey() {
    const key = process.env.NEBIUS_API_KEY ?? readKeychain();
    return key && looksValid(key) ? key : undefined;
}
function readKeychain() {
    try {
        return execFileSync("security", ["find-generic-password", "-s", "NEBIUS_API_KEY", "-w"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined;
    }
    catch {
        return undefined;
    }
}
// Cheap shape check, not real verification: "v1.<part>.<part>" and long enough that a truncated
// paste is rejected up front instead of spending a call to learn it was never going to work.
export function looksValid(key) {
    return key.length >= MIN_KEY_LENGTH && /^v1\.[^.]+\.[^.]+$/.test(key);
}
