// Each reader against a synthetic home directory shaped like the real tool's on-disk layout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as claude from '../src/sources/claude.mjs';
import * as codex from '../src/sources/codex.mjs';
import * as kimi from '../src/sources/kimi.mjs';
import * as hermes from '../src/sources/hermes.mjs';
import * as openclaw from '../src/sources/openclaw.mjs';
import * as cursor from '../src/sources/cursor.mjs';
import { run } from '../src/estate.mjs';

let H, EMPTY;
const put = (rel, body) => {
  const p = join(H, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Array.isArray(body) ? body.map((l) => JSON.stringify(l)).join('\n') + '\n' : body);
};
const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);

before(async () => {
  H = mkdtempSync(join(tmpdir(), 'route-home-'));
  EMPTY = mkdtempSync(join(tmpdir(), 'route-empty-'));

  put('.claude.json', JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription', userRateLimitTier: 'max_20x', emailAddress: 'x@y' } }));
  const cu = (id, extra = {}) => ({ requestId: id, cwd: '/w/alpha', timestamp: '2026-09-01T10:00:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 10000, output_tokens: 20000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 5000 } }, ...extra });
  put('.claude/projects/-w-alpha/s1.jsonl', [cu('r1'), cu('r1'), cu('r2'), { requestId: 'r3', message: { model: '<synthetic>', usage: {} } }]);
  put('.claude/projects/-w-alpha/s1/subagents/a.jsonl', [cu('r4')]);

  const tc = (at, total, last, rl) => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last }, rate_limits: rl } });
  const rl = (p, s) => ({ limit_id: 'codex', plan_type: 'plus', primary: { used_percent: p, window_minutes: 300 }, secondary: { used_percent: s, window_minutes: 10080 } });
  const now = new Date().toISOString();
  put('.codex/sessions/2026/09/20/rollout-a.jsonl', [
    { type: 'session_meta', payload: { cwd: '/w/beta', model_provider: 'openai' } },
    { type: 'turn_context', payload: { cwd: '/w/beta', model: 'gpt-5.4' } },
    tc(now, 150, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 50 }, rl(40, 10)),
    tc(now, 150, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 50 }, rl(40, 10)),
    tc(now, 400, { input_tokens: 200, cached_input_tokens: 0, output_tokens: 50 }, rl(90, 20)),
    tc(new Date(Date.now() + 1000).toISOString(), 400, null, rl(15, 21)),
  ]);

  const session = join(H, '.kimi-code/sessions/wd_gamma_0123456789ab/session_1');
  put('.kimi-code/session_index.jsonl', [{ sessionDir: session, workDir: '/w/gamma' }]);
  put('.kimi-code/sessions/wd_gamma_0123456789ab/session_1/agents/main/wire.jsonl', [
    { type: 'usage.record', model: 'kimi-code/k3-256k', time: 1789558919832, usageScope: 'turn', usage: { inputOther: 30, output: 7, inputCacheRead: 100, inputCacheCreation: 0 } },
    { type: 'context.append_loop_event', usage: { inputOther: 999 } },
  ]);
  put('.kimi-code/sessions/wd_orphan_0123456789ab/session_2/agents/main/wire.jsonl', [
    { type: 'usage.record', model: 'moonshot/kimi-k3', time: 1789558919832, usage: { inputOther: 1, output: 1 } },
  ]);
  const md5 = createHash('md5').update('/w/delta').digest('hex');
  put('.kimi/config.toml', 'default_model = "kimi-code/kimi-for-coding"\n');
  put('.kimi/kimi.json', JSON.stringify({ work_dirs: [{ path: '/w/delta' }] }));
  const su = (id) => ({ timestamp: 1779797993.6, message: { type: 'StatusUpdate', payload: { message_id: id, token_usage: { input_other: 5, output: 3, input_cache_read: 9, input_cache_creation: 0 } } } });
  put(`.kimi/sessions/${md5}/s1/wire.jsonl`, [su('m1'), su('m1'), su('m2')]);

  const Database = await hermes.sqlite();
  if (Database) {
    mkdirSync(join(H, '.hermes'));
    const db = new Database(join(H, '.hermes/state.db'));
    db.exec(`create table sessions (id text primary key, model text, billing_provider text, billing_base_url text, billing_mode text,
      api_call_count int, input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, actual_cost_usd real,
      estimated_cost_usd real, started_at real, cwd text, git_repo_root text);
      create table session_model_usage (session_id text, model text, billing_provider text, billing_base_url text, billing_mode text,
      api_call_count int, input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, actual_cost_usd real,
      estimated_cost_usd real, first_seen real);
      insert into sessions values ('s1', 'gpt-5.4', 'openai-codex', '', 'subscription_included', 3, 1000, 100, 5000, 0, 0, 0, 1789000000, '/w/eps', null);
      insert into session_model_usage values ('s1', 'gpt-5.4', 'openai-codex', '', 'subscription_included', 3, 1000, 100, 5000, 0, 0, 0, 1789000000);
      insert into session_model_usage values ('s1', 'gemma4:12b', 'custom', 'http://localhost:11434/v1', '', 2, 50, 5, 0, 0, 0, 0, 1789000000);
      insert into sessions values ('s0', 'claude-opus-5', 'anthropic', '', 'api', 1, 10, 10, 0, 0, 0.42, 0, 1788000000, '/w/zeta', null);`);
    db.close();
  }

  put('.openclaw/openclaw.json', JSON.stringify({ models: { providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' }, kimi: { baseUrl: 'https://api.kimi.com/coding/' } } } }));
  const oc = (provider, model, usage) => ({ type: 'message', timestamp: '2026-09-02T00:00:00Z', message: { role: 'assistant', provider, api: provider === 'ollama' ? 'ollama' : 'anthropic-messages', model, usage } });
  put('.openclaw/agents/main/sessions/a.jsonl', [
    { type: 'session', cwd: '/w/theta' },
    oc('ollama', 'llama3.2:3b', { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 }),
    oc('kimi', 'kimi-k2-thinking', { input: 30, output: 3, cacheRead: 10, cacheWrite: 0, cost: { total: 0 } }),
    oc('kimi', 'kimi-k2-thinking', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    { type: 'message', message: { role: 'user', content: 'hi' } },
  ]);

  mkdirSync(join(H, 'Library/Application Support/Cursor'), { recursive: true });
});

after(() => { rmSync(H, { recursive: true, force: true }); rmSync(EMPTY, { recursive: true, force: true }); });

test('claude-code: dedupes request ids, skips synthetic, reads subagent transcripts, reads billing', async () => {
  const s = await claude.read(H);
  assert.equal(s.status, 'ok');
  assert.equal(s.records.length, 3);
  assert.equal(s.plan, 'max_20x');
  assert.ok(s.records.every((r) => r.billing === 'subscription' && r.project === 'alpha' && r.day === '2026-09-01'));
  assert.deepEqual([sum(s.records, 'input'), sum(s.records, 'cache_read')], [30000, 300000]);
});

test('codex: one record per new call, cached input split out, plan limits tracked', async () => {
  const s = await codex.read(H);
  assert.equal(s.records.length, 2);
  assert.equal(s.plan, 'plus');
  assert.deepEqual(s.records.map((r) => [r.input, r.cache_read, r.output]), [[40, 60, 50], [200, 0, 50]]);
  assert.ok(s.records.every((r) => r.model === 'gpt-5.4' && r.project === 'beta' && r.billing === 'subscription'));
  assert.equal(s.limits.primary.used_percent, 15);
  assert.equal(s.limits.primary.peak_30d, 90);
  assert.equal(s.limits.secondary.window_minutes, 10080);
});

test('kimi: reads 2.x usage.record and 1.x StatusUpdate, maps work dirs', async () => {
  const s = await kimi.read(H);
  const v2 = s.records.filter((r) => r.model === 'kimi-code/k3-256k');
  assert.equal(v2.length, 1);
  assert.deepEqual([v2[0].project, v2[0].input, v2[0].cache_read, v2[0].billing], ['gamma', 30, 100, 'subscription']);
  const orphan = s.records.find((r) => r.model === 'moonshot/kimi-k3');
  assert.deepEqual([orphan.project, orphan.billing], ['orphan', 'api']);
  const v1 = s.records.filter((r) => r.model === 'kimi-code/kimi-for-coding');
  assert.equal(v1.length, 2);
  assert.ok(v1.every((r) => r.project === 'delta' && r.billing === 'subscription'));
});

test('hermes: per-model rows plus orphan sessions, billing classified', async (t) => {
  if (!(await hermes.sqlite())) return t.skip('node:sqlite unavailable');
  const s = await hermes.read(H);
  const by = Object.fromEntries(s.records.map((r) => [r.model, r]));
  assert.equal(s.records.length, 3);
  assert.deepEqual([by['gpt-5.4'].billing, by['gpt-5.4'].plan_via, by['gpt-5.4'].requests, by['gpt-5.4'].project], ['subscription', 'codex', 3, 'eps']);
  assert.equal(by['gemma4:12b'].billing, 'local');
  assert.deepEqual([by['claude-opus-5'].billing, by['claude-opus-5'].reported_usd, by['claude-opus-5'].project], ['api', 0.42, 'zeta']);
});

test('openclaw: billing from provider endpoint, zero-usage turns skipped', async () => {
  const s = await openclaw.read(H);
  assert.equal(s.records.length, 2);
  const [local, sub] = s.records;
  assert.deepEqual([local.billing, local.project], ['local', 'theta']);
  assert.deepEqual([sub.billing, sub.plan_via, sub.cache_read], ['subscription', 'kimi', 10]);
});

test('cursor: detected but reported as not yet supported', async () => {
  assert.equal((await cursor.read(H)).status, 'unsupported');
  assert.equal((await cursor.read(EMPTY)).status, 'absent');
});

test('every reader reports absent on an empty home', async () => {
  for (const m of [claude, codex, kimi, hermes, openclaw]) assert.equal((await m.read(EMPTY)).status, 'absent', m.tool);
});

test('audit: splits paid from API-equivalent, groups subscriptions by the plan that pays', async () => {
  const out = await run({ home: H, out: false, print: false, plans: { codex: 20 } });
  assert.equal(out.schema, 'route.estate.v2');
  assert.equal(out.inventory, null);
  const tool = Object.fromEntries(out.tools.map((t) => [t.tool, t]));
  assert.equal(tool['claude-code'].paid_usd, 0);
  assert.ok(tool['claude-code'].equiv_usd > 0);
  assert.equal(tool.openclaw.local_tokens, 44);
  const codexPlan = out.subscriptions.find((s) => s.tool === 'codex');
  assert.equal(codexPlan.tier, 'plus');
  assert.equal(codexPlan.fee_usd_month, 20);
  assert.ok(codexPlan.limits.primary);
  if (tool.hermes) {
    assert.deepEqual(codexPlan.used_by.sort(), ['codex', 'hermes']);
    assert.equal(out.spend.total_usd, 0.42);
  }
  assert.ok(out.summary.offloadable_equiv_usd > 0);
  assert.ok(out.sources.find((s) => s.tool === 'cursor').status === 'unsupported');
});

test('audit: --billing override and --source filter', async () => {
  const out = await run({ home: H, out: false, print: false, only: ['openclaw'], billing: { openclaw: 'api' } });
  assert.deepEqual(out.sources.map((s) => s.tool), ['openclaw']);
  assert.equal(out.tools[0].mode, 'api');
});

test('audit: empty machine does not crash', async () => {
  const out = await run({ home: EMPTY, out: false, print: false });
  assert.equal(out.spend.requests, 0);
  assert.deepEqual(out.subscriptions, []);
});
