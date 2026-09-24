// OpenClaw: model-agnostic gateway. ~/.openclaw/agents/<agent>/sessions/*.jsonl, a session header
// with the working directory, then one message per turn carrying provider, model and usage.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, walk, lines, pool, project, day, record, billingFromUrl, planFrom } from './common.mjs';

export const tool = 'openclaw';

// OpenClaw prices every call from its model table whatever the auth, so a reported cost alone does
// not prove the operator paid it. Billing is classified from the provider's configured endpoint.
const billingOf = (m, urls) => {
  const byUrl = billingFromUrl(urls[m.provider]);
  if (byUrl) return byUrl;
  const via = `${m.provider || ''} ${m.api || ''}`;
  if (/ollama|lmstudio|llama\.?cpp|vllm/i.test(via)) return 'local';
  if (/codex/i.test(via)) return 'subscription';
  return 'unknown';
};

export async function read(h = home()) {
  const state = process.env.OPENCLAW_STATE_DIR || join(h, '.openclaw');
  const root = join(state, 'agents');
  if (!existsSync(root)) return { tool, status: 'absent', records: [] };
  let urls = {};
  try {
    const providers = JSON.parse(readFileSync(join(state, 'openclaw.json'), 'utf8')).models?.providers || {};
    urls = Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v?.baseUrl]));
  } catch {}
  const files = walk(root, (n, p) => n.endsWith('.jsonl') && /[\\/]sessions[\\/]/.test(p));
  const records = [];
  await pool(files, 16, async (f) => {
    let cwd = null;
    await lines(f, null, (r) => {
      if (r.type === 'session') { cwd = r.cwd || cwd; return; }
      const m = r.message, u = m?.usage;
      if (r.type !== 'message' || m.role !== 'assistant' || !u) return;
      if (!((u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0))) return;
      records.push(record({
        tool, model: m.model || 'unknown', billing: billingOf(m, urls), plan_via: planFrom(urls[m.provider], m.provider), project: project(cwd), day: day(r.timestamp ?? m.timestamp),
        input: u.input || 0, output: u.output || 0, cache_read: u.cacheRead || 0, cache_create: u.cacheWrite || 0,
        reported_usd: u.cost?.total || null,
      }));
    });
  });
  return { tool, status: 'ok', plan: null, files: files.length, records };
}
