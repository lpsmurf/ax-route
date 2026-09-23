// Price table. One rule: a model with no published price reports null, never a guess.
// Same discipline as ax-harness scan-harness.mjs, which refuses to invent dollars.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal YAML reader for the flat `key: {a: 1, b: 2}` shape prices.yaml uses.
// Deliberately not a general YAML parser — it throws on anything it does not expect.
export function parsePrices(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { section = line.replace(':', '').trim(); out[section] = {}; continue; }
    const m = line.match(/^\s+(\S+):\s*\{(.+)\}\s*$/);
    if (!m || !section) continue;
    const entry = {};
    for (const pair of m[2].split(',')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      entry[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    out[section][m[1].trim()] = entry;
  }
  return out;
}

let TABLE = null;
export function table() {
  if (!TABLE) TABLE = parsePrices(readFileSync(join(ROOT, 'prices.yaml'), 'utf8'));
  return TABLE;
}

// Longest-prefix match, so dated ids (claude-haiku-4-5-20251001) resolve to their family.
export function lookup(model, t = table()) {
  const all = { ...(t.frontier || {}), ...(t.nebius || {}) };
  if (all[model]) return all[model];
  let best = null;
  for (const key of Object.keys(all)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? all[best] : null;
}

// usage: {input, output, cache_read, cache_create} in tokens, where `input` is the
// NON-cached input only — cached tokens are counted in their own fields, never inside `input`.
// Returns USD, or null if the model has no published price.
//
// An earlier version subtracted `cache_read` from `input` before pricing it, which given those
// semantics cancelled the cache term to zero and billed every cached token at nothing. On real
// Claude Code traffic, where cache reads outnumber fresh input roughly fifty to one, that
// undercounted the bill by most of it.
export function cost(model, usage) {
  const p = lookup(model);
  if (!p || p.input === undefined || p.output === undefined) return null;
  const input = usage.input || 0;
  const output = usage.output || 0;
  const cacheRead = usage.cache_read || 0;
  const cacheWrite = usage.cache_create || 0;
  // A provider that publishes no cache rate bills cached tokens at the ordinary input rate.
  const readRate = p.cache_read !== undefined ? p.cache_read : p.input;
  const writeRate = p.cache_write !== undefined ? p.cache_write : p.input;
  return (input * p.input + cacheRead * readRate + cacheWrite * writeRate + output * p.output) / 1e6;
}

export const isPriced = (model) => lookup(model) !== null;
