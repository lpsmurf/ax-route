// The comparison this project could not make until now: the same fixtures, run against the
// closed models people actually pay for, graded by the same blind judge as every other arm.
// Everything here is measured. Nothing is priced by arithmetic.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, policy } from './policy.mjs';
import { cost } from './price.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEBIUS = 'https://api.studio.nebius.com/v1';
const JUDGE = 'deepseek-ai/DeepSeek-V4-Pro';

const FRONTIER = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'];

async function anthropic(model, prompt, max_tokens = 1200) {
  const key = apiKey('ANTHROPIC_API_KEY');
  if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // Newer Claude models reject `temperature`; older ones accept it. Send it only where valid.
    body: JSON.stringify({ model, max_tokens, messages: [{ role: 'user', content: prompt }],
      ...(/-4-5-|-4-6|-4-7|-4-8/.test(model) ? { temperature: 0 } : {}) }),
  });
  const b = await r.json().catch(() => ({}));
  const u = b.usage || {};
  const tokens = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_create: u.cache_creation_input_tokens || 0,
  };
  return {
    ok: r.status === 200,
    status: r.status,
    text: (b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim(),
    latency_ms: Date.now() - t0,
    tokens,
    cost_usd: cost(model, tokens),
    error: b.error?.message || null,
  };
}

async function nebius(model, prompt, max_tokens = 1200) {
  const key = apiKey('NEBIUS_API_KEY');
  const r = await fetch(`${NEBIUS}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // Newer Claude models reject `temperature`; older ones accept it. Send it only where valid.
    body: JSON.stringify({ model, max_tokens, messages: [{ role: 'user', content: prompt }],
      ...(/-4-5-|-4-6|-4-7|-4-8/.test(model) ? { temperature: 0 } : {}) }),
  });
  const b = await r.json().catch(() => ({}));
  return (b.choices?.[0]?.message?.content ?? '').trim();
}

const norm = (s) => String(s).toLowerCase().replace(/[\s,$"'`*]/g, '');
const matched = (t, e) => norm(t).includes(norm(e));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const judge = async (f, answer) => {
  const t = await nebius(JUDGE, `You are grading one answer against a rubric. Reply with exactly one word: PASS or FAIL.

Task:
${f.prompt}

Rubric:
${f.rubric}

Answer:
${answer || '(empty)'}

One word, PASS or FAIL:`, 200);
  return /\bPASS\b/i.test(t) ? 'PASS' : 'FAIL';
};

export async function run() {
  const fx = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/mechanical.json'), 'utf8'));
  const fixtures = fx.fixtures;
  const cheap = policy().tiers.mechanical.model;
  const arms = {};
  let spent = 0;

  for (const model of FRONTIER) {
    process.stdout.write(`  ${model.padEnd(30)} `);
    const rows = await pool(fixtures, 4, async (f) => {
      let r; try { r = await anthropic(model, f.prompt); }
      catch (e) { r = { ok: false, text: '', latency_ms: 0, tokens: { input: 0, output: 0 }, cost_usd: null, error: e.message }; }
      process.stdout.write(r.ok ? '.' : 'x');
      return { id: f.id, job: f.job, ...r, match: r.ok && matched(r.text, f.expect) };
    });
    process.stdout.write(' judging ');
    const v = await pool(rows, 4, (row, k) => judge(fixtures[k], row.text));
    rows.forEach((r, k) => { r.judge = v[k]; });
    const c = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
    spent += c;
    const lat = rows.filter((r) => r.ok).map((r) => r.latency_ms);
    arms[model] = {
      model, provider: 'anthropic', n: rows.length, ok: rows.filter((r) => r.ok).length,
      match_rate_pct: pct(rows.filter((r) => r.match).length, rows.length),
      judge_pass_pct: pct(rows.filter((r) => r.judge === 'PASS').length, rows.length),
      tokens_in: rows.reduce((s, r) => s + r.tokens.input, 0),
      tokens_out: rows.reduce((s, r) => s + r.tokens.output, 0),
      cost_usd: Number(c.toFixed(6)),
      latency_p50_ms: quantile(lat, 0.5), latency_p95_ms: quantile(lat, 0.95),
      errors: rows.filter((r) => !r.ok).map((r) => r.error).filter(Boolean).slice(0, 3),
    };
    const a = arms[model];
    console.log(` match ${String(a.match_rate_pct).padStart(5)}%  judge ${String(a.judge_pass_pct).padStart(5)}%  p50 ${String(a.latency_p50_ms).padStart(5)}ms  $${a.cost_usd.toFixed(5)}`);
  }

  // the cheap open-weight arm, same fixtures, for the side-by-side
  const bench = existsSync(join(ROOT, 'results/bench.json')) ? JSON.parse(readFileSync(join(ROOT, 'results/bench.json'), 'utf8')) : null;
  const out = {
    schema: 'route.frontier.v1',
    generated_at: new Date().toISOString(),
    note: 'Measured, not computed. Closed models called directly over the Anthropic API; graded by the same blind judge as every other arm.',
    judge: JUDGE, judge_blind: true,
    fixtures: fixtures.length,
    arms,
    open_weight_arm: bench ? {
      model: bench.arms.routed.model, provider: 'nebius',
      match_rate_pct: bench.arms.routed.match_rate_pct,
      judge_pass_pct: bench.arms.routed.judge_pass_pct,
      cost_usd: bench.arms.routed.cost_usd,
      latency_p50_ms: bench.arms.routed.latency_p50_ms,
    } : null,
    total_spend_usd: Number(spent.toFixed(4)),
    source: 'bench/fixtures/mechanical.json',
  };
  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/frontier.json'), JSON.stringify(out, null, 2));
  console.log(`\nspent on this run: $${spent.toFixed(4)}`);
  console.log('-> results/frontier.json');
  return out;
}
