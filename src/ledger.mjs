// Append-only record of every routing decision. The audit trail is the product:
// a saving you cannot show a receipt for is a claim, not a result.
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_DIR = process.env.ROUTE_LEDGER_DIR || join(ROOT, 'ledger');

export function append(entry) {
  if (!existsSync(LEDGER_DIR)) mkdirSync(LEDGER_DIR, { recursive: true });
  const file = join(LEDGER_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  return file;
}

export function read(day = new Date().toISOString().slice(0, 10)) {
  const file = join(LEDGER_DIR, `${day}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
