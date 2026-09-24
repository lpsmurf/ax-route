// Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Each response emits a token_count event
// carrying the per-call usage and, on ChatGPT plans, how much of each rate-limit window is used.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, walk, lines, pool, project, day, record } from './common.mjs';

export const tool = 'codex';

export async function read(h = home()) {
  const root = join(process.env.CODEX_HOME || join(h, '.codex'), 'sessions');
  if (!existsSync(root)) return { tool, status: 'absent', records: [] };
  const files = walk(root, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
  const records = [];
  const snaps = [];
  await pool(files, 16, async (f) => {
    let cwd = null, model = null, prev = 0;
    await lines(f, null, (r) => {
      const p = r.payload || {};
      if (r.type === 'session_meta' || r.type === 'turn_context') { cwd = p.cwd || cwd; model = p.model || model; return; }
      if (p.type !== 'token_count') return;
      if (p.rate_limits) snaps.push({ at: r.timestamp, ...p.rate_limits });
      // token_count repeats without new usage; only a rising running total is a new call.
      const total = p.info?.total_token_usage?.total_tokens || 0;
      const u = p.info?.last_token_usage;
      if (!u || total <= prev) return;
      prev = total;
      // OpenAI counts cached tokens inside input_tokens; split them out so they price at the cache rate.
      const cached = u.cached_input_tokens || 0;
      records.push(record({
        tool, model: model || 'unknown', project: project(cwd), day: day(r.timestamp),
        input: Math.max(0, (u.input_tokens || 0) - cached), output: u.output_tokens || 0,
        cache_read: cached, cache_create: u.cache_write_input_tokens || 0,
      }));
    });
  });
  snaps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const plan = snaps.map((s) => s.plan_type).filter(Boolean).at(-1) || null;
  for (const r of records) r.billing = plan ? 'subscription' : 'api';
  return { tool, status: 'ok', plan, files: files.length, records, limits: limits(snaps) };
}

function limits(snaps) {
  const last = snaps.at(-1);
  if (!last) return null;
  const since = Date.now() - 30 * 864e5;
  const window = (k) => {
    if (!last[k]) return null;
    const recent = snaps.filter((s) => s[k] && Date.parse(s.at) >= since).map((s) => s[k].used_percent || 0);
    return { window_minutes: last[k].window_minutes, used_percent: last[k].used_percent, peak_30d: Math.max(0, ...recent) };
  };
  return { as_of: last.at, primary: window('primary'), secondary: window('secondary') };
}
