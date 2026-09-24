// Kimi Code. Two on-disk layouts are live in the wild:
//   2.x  ~/.kimi-code/sessions/wd_<dir>_<hash>/session_*/agents/*/wire.jsonl — `usage.record` events
//   1.x  ~/.kimi/sessions/<md5(workdir)>/<session>/wire.jsonl — `StatusUpdate` events
// 1.x does not log the model per call, so the configured default model stands in for it.
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { home, walk, lines, pool, project, day, record } from './common.mjs';

export const tool = 'kimi';

const md5 = (s) => createHash('md5').update(s).digest('hex');
// Models served under the Kimi Code membership are prefixed kimi-code/; anything else is metered.
const billingFor = (model) => (/^kimi-code\//.test(model || '') ? 'subscription' : 'api');

const jsonl = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
};

export async function read(h = home()) {
  const v2 = join(h, '.kimi-code'), v1 = join(h, '.kimi');
  if (!existsSync(join(v2, 'sessions')) && !existsSync(join(v1, 'sessions'))) return { tool, status: 'absent', records: [] };
  const records = [];

  const workDirs = Object.fromEntries(jsonl(join(v2, 'session_index.jsonl')).map((r) => [r.sessionDir, r.workDir]));
  const f2 = walk(join(v2, 'sessions'), (n) => n === 'wire.jsonl');
  await pool(f2, 16, (f) => {
    const session = f.split(/[\\/]agents[\\/]/)[0];
    const proj = workDirs[session]
      ? project(workDirs[session])
      : basename(dirname(session)).replace(/^wd_/, '').replace(/_[0-9a-f]{12}$/, '') || 'unknown';
    return lines(f, '"usage.record"', (r) => {
      const u = r.usage; if (r.type !== 'usage.record' || !u) return;
      records.push(record({
        tool, model: r.model || 'unknown', billing: billingFor(r.model), project: proj, day: day(r.time),
        input: u.inputOther || 0, output: u.output || 0, cache_read: u.inputCacheRead || 0, cache_create: u.inputCacheCreation || 0,
      }));
    });
  });

  let model = null;
  try { model = readFileSync(join(v1, 'config.toml'), 'utf8').match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] || null; } catch {}
  let dirs = {};
  try { dirs = Object.fromEntries((JSON.parse(readFileSync(join(v1, 'kimi.json'), 'utf8')).work_dirs || []).map((w) => [md5(w.path), w.path])); } catch {}
  const seen = new Set();
  const f1 = walk(join(v1, 'sessions'), (n) => n === 'wire.jsonl');
  await pool(f1, 16, (f) => {
    const proj = project(dirs[basename(dirname(dirname(f)))]);
    return lines(f, '"token_usage"', (r) => {
      const p = r.message?.payload, u = p?.token_usage;
      if (r.message?.type !== 'StatusUpdate' || !u) return;
      if (p.message_id) { if (seen.has(p.message_id)) return; seen.add(p.message_id); }
      records.push(record({
        tool, model: model || 'unknown', billing: billingFor(model), project: proj, day: day(r.timestamp),
        input: u.input_other || 0, output: u.output || 0, cache_read: u.input_cache_read || 0, cache_create: u.input_cache_creation || 0,
      }));
    });
  });

  return { tool, status: 'ok', plan: null, files: f1.length + f2.length, records };
}
