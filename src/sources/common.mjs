// Shared plumbing for the per-tool usage readers. Every reader returns records in one shape:
//   { tool, model, project, day, requests, input, output, cache_read, cache_create, billing, reported_usd }
// `input` is NON-cached input only, same contract as price.mjs. `billing` is one of
// api | subscription | local | unknown — how the operator actually pays for those tokens.
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const home = () => process.env.ROUTE_HOME || homedir();

export function walk(dir, match, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out);
    else if (match(e.name, p)) out.push(p);
  }
  return out;
}

// Stream a JSONL file; `needle` skips lines cheaply before paying for JSON.parse.
export function lines(file, needle, fn) {
  return new Promise((res) => {
    const input = createReadStream(file);
    input.on('error', res);
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (!l || (needle && !l.includes(needle))) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      fn(r);
    });
    rl.on('close', res);
  });
}

// Bounded concurrency, so a machine with thousands of transcripts does not run out of file handles.
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export const project = (cwd) => (cwd ? basename(String(cwd).replace(/[\\/]+$/, '')) || 'unknown' : 'unknown');

export const day = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const d = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Endpoints on the operator's own machine, and endpoints that only serve flat-fee plans.
export const billingFromUrl = (url) => {
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url || '')) return 'local';
  if (planFrom(url)) return 'subscription';
  return null;
};

// Model-agnostic agents (Hermes, OpenClaw) often ride another tool's plan. Name that plan, so its
// value and rate limits are counted once, against the plan that actually pays for them.
export const planFrom = (...hints) => {
  const s = hints.filter(Boolean).join(' ');
  if (/api\.kimi\.com\/coding|kimi-code/i.test(s)) return 'kimi';
  if (/chatgpt\.com\/backend-api|codex/i.test(s)) return 'codex';
  return null;
};

export const record = (r) => ({
  model: 'unknown', project: 'unknown', day: null, requests: 1,
  input: 0, output: 0, cache_read: 0, cache_create: 0, billing: 'unknown', reported_usd: null, plan_via: null, ...r,
});
