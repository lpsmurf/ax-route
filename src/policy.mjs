// policy.yaml -> a routing decision. ~60 lines, no dependencies.
// The harness frontmatter() mini-parser cannot handle this nested shape, so this is its own.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parsePolicy(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const [k, ...rest] = line.split(':');
      const inline = rest.join(':').trim();
      if (inline) { out[k.trim()] = inline.replace(/^["']|["']$/g, ''); section = null; }
      else { section = k.trim(); out[section] = {}; }
      continue;
    }
    const m = line.match(/^\s+([\w.\/-]+):\s*\{(.+)\}\s*$/);
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

let POLICY = null;
export function policy() {
  if (!POLICY) POLICY = parsePolicy(readFileSync(process.env.ROUTE_POLICY || join(ROOT, 'policy.yaml'), 'utf8'));
  return POLICY;
}

// Keys come from env, else the macOS Keychain. Never from a file in the repo.
export function apiKey(keyEnv) {
  if (process.env[keyEnv]) return process.env[keyEnv];
  try {
    return execFileSync('security', ['find-generic-password', '-s', keyEnv, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

export function resolve(job, p = policy()) {
  const known = p.jobs?.[job];
  const tierName = known?.tier || p.default_tier;
  const tier = p.tiers?.[tierName];
  if (!tier) throw new Error(`policy: no tier "${tierName}"`);
  const provider = p.providers?.[tier.provider];
  if (!provider) throw new Error(`policy: no provider "${tier.provider}"`);
  return {
    job: job || '(none)',
    known: Boolean(known),
    tier: tierName,
    model: tier.model,
    provider: tier.provider,
    base_url: provider.base_url,
    key_env: provider.key_env,
    region: provider.region,
    was: known?.was || null,
    reason: known ? `job "${job}" is pinned to tier "${tierName}"` : `job "${job}" not in policy; default tier "${tierName}"`,
  };
}

export const jobs = (p = policy()) => Object.keys(p.jobs || {});
