// Claude Code: one JSONL transcript per session under ~/.claude/projects, one usage block per API call.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, walk, lines, pool, project, day, record } from './common.mjs';

export const tool = 'claude-code';

// Billing comes from the signed-in account, never from the transcripts. Only the billing type and
// rate-limit tier are read; identity fields in the same file are ignored.
function account(h) {
  try {
    const a = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8')).oauthAccount;
    if (!a) return { billing: 'api', plan: null };
    return {
      billing: /subscription/i.test(a.billingType || '') ? 'subscription' : 'unknown',
      plan: a.userRateLimitTier || a.seatTier || null,
    };
  } catch { return { billing: 'unknown', plan: null }; }
}

export async function read(h = home()) {
  const root = process.env.ROUTE_TRANSCRIPTS || join(h, '.claude', 'projects');
  if (!existsSync(root)) return { tool, status: 'absent', records: [] };
  const files = walk(root, (n) => n.endsWith('.jsonl'));
  const { billing, plan } = account(h);
  const seen = new Map();
  const records = [];
  await pool(files, 32, (f) => lines(f, '"usage"', (r) => {
    const u = r.message?.usage; if (!u) return;
    const model = r.message?.model; if (!model || model === '<synthetic>') return;
    // One assistant message is written once per content block, and earlier blocks can carry a
    // partial output count: keep one record per call and the largest output seen for it.
    const id = r.message?.id && r.requestId ? `${r.message.id}:${r.requestId}` : r.requestId || r.uuid;
    if (!id) return;
    const prev = seen.get(id);
    if (prev) { prev.output = Math.max(prev.output, u.output_tokens || 0); return; }
    seen.set(id, records[records.push(record({
      tool, model, billing, project: project(r.cwd), day: day(r.timestamp),
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0, cache_create: u.cache_creation_input_tokens || 0,
    })) - 1]);
  }));
  return { tool, status: 'ok', plan, files: files.length, records };
}
