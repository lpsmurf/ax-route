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
    const rows = [];
    await lines(f, null, (r) => rows.push(r));
    // Newer rollouts write one token_usage_record per response; older ones only have token_count,
    // repeated while nothing changed, so a call is counted when the running total moves. It can
    // move down (a resumed or compacted session), which is still a new call.
    const perResponse = rows.some((r) => r.type === 'token_usage_record');
    let cwd = null, model = null, prev;
    for (const r of rows) {
      const p = r.payload || {};
      if (r.type === 'session_meta' || r.type === 'turn_context') { cwd = p.cwd || cwd; model = p.model || model; continue; }
      if (p.type === 'token_count' && p.rate_limits) snaps.push({ at: r.timestamp, ...p.rate_limits });
      let u;
      if (perResponse) { if (r.type === 'token_usage_record') u = p.usage; }
      else if (p.type === 'token_count' && p.info) {
        const total = p.info.total_token_usage?.total_tokens || 0;
        if (total !== prev) { prev = total; u = p.info.last_token_usage; }
      }
      if (!u) continue;
      // OpenAI counts cached and cache-write tokens inside input_tokens; split them out so they price
      // at their own rates.
      const cached = u.cached_input_tokens || 0, written = u.cache_write_input_tokens || 0;
      records.push(record({
        tool, model: p.model || model || 'unknown', project: project(cwd), day: day(r.timestamp),
        input: Math.max(0, (u.input_tokens || 0) - cached - written), output: u.output_tokens || 0,
        cache_read: cached, cache_create: written,
      }));
    }
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
