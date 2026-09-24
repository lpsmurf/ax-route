// Hermes Agent: model-agnostic, so it records per session AND per model which provider served the
// tokens and how they were billed. Read from ~/.hermes/state.db with Node's built-in SQLite.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, project, day, record, billingFromUrl, planFrom } from './common.mjs';

export const tool = 'hermes';

// node:sqlite is built in from Node 22.5 and prints an ExperimentalWarning on load; silence only that one.
export async function sqlite() {
  const warn = process.emitWarning;
  process.emitWarning = (w, ...a) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : warn.call(process, w, ...a));
  try { return (await import('node:sqlite')).DatabaseSync; } catch { return null; } finally { process.emitWarning = warn; }
}

const cols = (t) => `${t}model model, ${t}billing_provider provider, ${t}billing_base_url base_url, ${t}billing_mode mode,
  ${t}api_call_count calls, ${t}input_tokens input, ${t}output_tokens output, ${t}cache_read_tokens cache_read,
  ${t}cache_write_tokens cache_create, ${t}actual_cost_usd actual, ${t}estimated_cost_usd estimated`;
// Per-model rows where they exist, plus whole-session rows for sessions that predate that table.
const PER_MODEL = `select ${cols('u.')}, coalesce(u.first_seen, s.started_at) at, coalesce(s.git_repo_root, s.cwd) cwd
  from session_model_usage u left join sessions s on s.id = u.session_id`;
const ORPHANS = `select ${cols('s.')}, s.started_at at, coalesce(s.git_repo_root, s.cwd) cwd from sessions s
  where not exists (select 1 from session_model_usage u where u.session_id = s.id)`;
const SESSIONS = `select ${cols('')}, started_at at, null cwd from sessions`;

const billingOf = (r) => {
  if (/subscription/i.test(r.mode || '') || /codex/i.test(r.provider || '')) return 'subscription';
  const byUrl = billingFromUrl(r.base_url);
  if (byUrl) return byUrl;
  if (/ollama|lmstudio|llama/i.test(r.provider || '')) return 'local';
  if ((r.actual || r.estimated) > 0) return 'api';
  return 'unknown';
};

export async function read(h = home()) {
  const db = join(process.env.HERMES_HOME || join(h, '.hermes'), 'state.db');
  if (!existsSync(db)) return { tool, status: 'absent', records: [] };
  const Database = await sqlite();
  if (!Database) return { tool, status: 'error', note: 'needs Node 22.5+ for built-in SQLite', records: [] };
  const conn = new Database(db, { readOnly: true });
  let rows;
  try {
    try { rows = [...conn.prepare(PER_MODEL).all(), ...conn.prepare(ORPHANS).all()]; }
    catch { rows = conn.prepare(SESSIONS).all(); }
  } finally { conn.close(); }
  const records = rows
    .filter((r) => (r.input || 0) + (r.output || 0) + (r.cache_read || 0) + (r.cache_create || 0) > 0)
    .map((r) => record({
      tool, model: r.model || 'unknown', billing: billingOf(r), plan_via: planFrom(r.provider, r.base_url), project: project(r.cwd), day: day(r.at),
      requests: r.calls || 1, input: r.input || 0, output: r.output || 0,
      cache_read: r.cache_read || 0, cache_create: r.cache_create || 0, reported_usd: r.actual || r.estimated || null,
    }));
  return { tool, status: 'ok', plan: null, files: 1, records };
}
