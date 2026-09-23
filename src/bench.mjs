// Head-to-head: the model the policy routes to, against a stronger, more expensive one.
//
// Two scorers on purpose. `match` is deterministic string checking and cannot be argued
// with; `judge` is an LLM grading against the rubric, blind to which arm produced the
// answer. Where they disagree, the disagreement is reported rather than resolved silently.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, policy } from './policy.mjs';
import { cost } from './price.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEBIUS = 'https://api.studio.nebius.com/v1';

// The routed arm is whatever policy.yaml picks for mechanical work — not a model
// chosen to flatter the result. The strong arm is the most capable model available.
export const ARMS = {
  routed: { model: policy().tiers.mechanical.model, provider: 'nebius', base_url: NEBIUS, key_env: 'NEBIUS_API_KEY' },
  strong: { model: 'deepseek-ai/DeepSeek-V4-Pro', provider: 'nebius', base_url: NEBIUS, key_env: 'NEBIUS_API_KEY' },
};
const JUDGE = { model: 'deepseek-ai/DeepSeek-V4-Pro', base_url: NEBIUS, key_env: 'NEBIUS_API_KEY' };

async function call({ model, base_url, key_env }, messages, max_tokens = 300) {
  const key = apiKey(key_env);
  if (!key) throw new Error(`no credential for ${key_env}`);
  const t0 = Date.now();
  const r = await fetch(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens, temperature: 0 }),
  });
  const latency_ms = Date.now() - t0;
  const body = await r.json().catch(() => ({}));
  const msg = body.choices?.[0]?.message || {};
  const u = body.usage || {};
  // OpenAI-wire usage: prompt_tokens already includes cached_tokens, so the non-cached
  // input is the difference. Passing prompt_tokens whole would bill the cached part twice.
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const tokens = { input: Math.max(0, (u.prompt_tokens ?? 0) - cached), output: u.completion_tokens ?? 0, cache_read: cached };
  return {
    ok: r.status === 200,
    status: r.status,
    // Reasoning models put the answer in `content` and their scratchpad in `reasoning`.
    text: (msg.content ?? '').trim(),
    latency_ms,
    tokens,
    cost_usd: cost(model, tokens),
  };
}

const norm = (s) => String(s).toLowerCase().replace(/[\s,$"'`*]/g, '');
const matched = (text, expect) => norm(text).includes(norm(expect));

async function judgeOne(fixture, answer) {
  const prompt = `You are grading one answer against a rubric. Reply with exactly one word: PASS or FAIL.

Task given to the assistant:
${fixture.prompt}

Rubric:
${fixture.rubric}

The assistant answered:
${answer || '(empty)'}

One word, PASS or FAIL:`;
  try {
    const r = await call(JUDGE, [{ role: 'user', content: prompt }], 200);
    return /\bPASS\b/i.test(r.text) ? 'PASS' : 'FAIL';
  } catch { return 'ERROR'; }
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function run({ n, only } = {}) {
  const fx = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/mechanical.json'), 'utf8'));
  let fixtures = fx.fixtures;
  if (only) fixtures = fixtures.filter((f) => f.job === only);
  if (n) fixtures = fixtures.slice(0, n);

  console.log(`bench: ${fixtures.length} fixtures x ${Object.keys(ARMS).length} arms`);
  const results = {};

  for (const [armName, arm] of Object.entries(ARMS)) {
    process.stdout.write(`  ${armName} (${arm.model}) `);
    const rows = await pool(fixtures, 5, async (f) => {
      let r;
      try { r = await call(arm, [{ role: 'user', content: f.prompt }]); }
      catch (e) { r = { ok: false, status: 0, text: '', latency_ms: 0, tokens: { input: 0, output: 0 }, cost_usd: null, error: e.message }; }
      process.stdout.write(r.ok ? '.' : 'x');
      return { id: f.id, job: f.job, ...r, match: r.ok && matched(r.text, f.expect) };
    });
    process.stdout.write(' judging ');
    const verdicts = await pool(rows, 5, async (row, k) => {
      const v = await judgeOne(fixtures[k], row.text);
      process.stdout.write(v === 'PASS' ? '+' : v === 'FAIL' ? '-' : '?');
      return v;
    });
    rows.forEach((r, k) => { r.judge = verdicts[k]; });
    console.log('');

    const lat = rows.filter((r) => r.ok).map((r) => r.latency_ms);
    const costs = rows.map((r) => r.cost_usd).filter((c) => c !== null);
    results[armName] = {
      model: arm.model,
      provider: arm.provider,
      n: rows.length,
      ok: rows.filter((r) => r.ok).length,
      match_rate_pct: pct(rows.filter((r) => r.match).length, rows.length),
      judge_pass_pct: pct(rows.filter((r) => r.judge === 'PASS').length, rows.length),
      disagreements: rows.filter((r) => r.match !== (r.judge === 'PASS')).map((r) => r.id),
      tokens_in: rows.reduce((s, r) => s + (r.tokens.input || 0), 0),
      tokens_out: rows.reduce((s, r) => s + (r.tokens.output || 0), 0),
      cost_usd: costs.length === rows.length ? Number(costs.reduce((s, c) => s + c, 0).toFixed(6)) : null,
      cost_note: costs.length === rows.length ? null : 'unpriced model — cost withheld rather than estimated',
      latency_p50_ms: quantile(lat, 0.5),
      latency_p95_ms: quantile(lat, 0.95),
      rows,
    };
  }

  const out = {
    schema: 'route.bench.v1',
    generated_at: new Date().toISOString(),
    fixtures_note: fx.note,
    fixture_count: fixtures.length,
    judge: JUDGE.model,
    judge_blind: true,
    arms: results,
    source: 'bench/fixtures/mechanical.json',
  };
  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/bench.json'), JSON.stringify(out, null, 2));

  console.log('\narm      model                                  match%  judge%  p50ms   cost');
  for (const [k, v] of Object.entries(results)) {
    console.log(
      k.padEnd(8),
      v.model.slice(0, 36).padEnd(38),
      String(v.match_rate_pct).padStart(5),
      String(v.judge_pass_pct).padStart(7),
      String(v.latency_p50_ms ?? '-').padStart(7),
      v.cost_usd === null ? '   (unpriced)' : `  $${v.cost_usd.toFixed(6)}`,
    );
  }
  console.log('\n-> results/bench.json');
  return out;
}
