// Cheap first, escalate on doubt.
//
// The static policy has an obvious hole: on realistic work the cheap model gives up real
// accuracy. Escalation closes it without paying frontier prices for everything — answer with
// the cheap model, have a cheap validator judge whether the answer actually addresses the task,
// and only pay for the strong model on the ones that fail. The gate itself costs tokens, so it
// is counted in the total like everything else.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, policy } from './policy.mjs';
import { cost } from './price.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEBIUS = 'https://api.studio.nebius.com/v1';
const JUDGE = 'deepseek-ai/DeepSeek-V4-Pro';

async function call(model, prompt, max_tokens = 1200) {
  const key = apiKey('NEBIUS_API_KEY');
  const t0 = Date.now();
  const r = await fetch(`${NEBIUS}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  const b = await r.json().catch(() => ({}));
  const u = b.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const tokens = { input: Math.max(0, (u.prompt_tokens ?? 0) - cached), output: u.completion_tokens ?? 0, cache_read: cached };
  return {
    ok: r.status === 200,
    text: (b.choices?.[0]?.message?.content ?? '').trim(),
    latency_ms: Date.now() - t0, tokens, cost_usd: cost(model, tokens) || 0,
  };
}

// The gate. A first version asked the cheap model whether its own answer looked complete.
// It escalated 1 task in 21 and changed nothing, because a wrong answer from a small model
// is usually well-formed and confident — form does not reveal wrongness.
//
// This version uses self-consistency instead: answer twice and escalate when the two runs
// disagree. Disagreement is a real signal of an unstable answer, and it costs one extra
// cheap call rather than a judgement the cheap model cannot make.
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 220);

async function gate(cheapModel, task, firstAnswer) {
  // A second independent attempt. Temperature is already 0, so we vary the framing slightly
  // to get an independent sample rather than a cached repeat.
  const r = await call(cheapModel, task + '\n\n(Answer directly and only as instructed.)', 400);
  return {
    escalate: key(r.text) !== key(firstAnswer),
    second: r.text,
    cost_usd: r.cost_usd, latency_ms: r.latency_ms, tokens: r.tokens,
  };
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
  const r = await call(JUDGE, `You are grading one answer against a rubric. Reply with exactly one word: PASS or FAIL.

Task:
${f.prompt}

Rubric:
${f.rubric}

Answer:
${answer || '(empty)'}

One word, PASS or FAIL:`, 200);
  return /\bPASS\b/i.test(r.text) ? 'PASS' : 'FAIL';
};

export async function run() {
  const fx = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/mechanical.json'), 'utf8'));
  const fixtures = fx.fixtures;
  const p = policy();
  const cheap = p.tiers.mechanical.model;
  const strong = 'deepseek-ai/DeepSeek-V4-Pro';

  console.log(`escalation: ${fixtures.length} tasks\n  cheap  ${cheap}\n  strong ${strong}\n`);
  process.stdout.write('  running ');
  const rows = await pool(fixtures, 5, async (f) => {
    const a = await call(cheap, f.prompt);
    const g = await gate(cheap, f.prompt, a.text);
    let final = a, escalated = false, strongCall = null;
    if (g.escalate) { strongCall = await call(strong, f.prompt); final = strongCall; escalated = true; }
    const total = a.cost_usd + g.cost_usd + (strongCall ? strongCall.cost_usd : 0);
    process.stdout.write(escalated ? '^' : '.');
    return { id: f.id, job: f.job, escalated, text: final.text,
      match: matched(final.text, f.expect),
      cost_usd: total, latency_ms: a.latency_ms + g.latency_ms + (strongCall ? strongCall.latency_ms : 0) };
  });
  process.stdout.write(' judging ');
  const v = await pool(rows, 5, (row, k) => judge(fixtures[k], row.text));
  rows.forEach((r, k) => { r.judge = v[k]; });
  console.log('');

  const esc = rows.filter((r) => r.escalated).length;
  const lat = rows.map((r) => r.latency_ms);
  const out = {
    schema: 'route.escalate.v1',
    generated_at: new Date().toISOString(),
    cheap_model: cheap, strong_model: strong, gate_model: cheap, judge: JUDGE,
    fixtures: fixtures.length,
    escalated: esc,
    escalation_rate_pct: pct(esc, rows.length),
    match_rate_pct: pct(rows.filter((r) => r.match).length, rows.length),
    judge_pass_pct: pct(rows.filter((r) => r.judge === 'PASS').length, rows.length),
    cost_usd: Number(rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(6)),
    latency_p50_ms: quantile(lat, 0.5), latency_p95_ms: quantile(lat, 0.95),
    note: 'Two cheap attempts on every task; the strong model runs only where they disagree. Both cheap calls are included in cost_usd. An earlier gate that asked the cheap model to self-assess escalated 1 task in 21 and changed nothing — a wrong answer from a small model is usually well-formed.',
    rows,
    source: 'bench/fixtures/mechanical.json',
  };
  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/escalate.json'), JSON.stringify(out, null, 2));
  console.log(`escalated ${esc}/${rows.length} (${out.escalation_rate_pct}%)  match ${out.match_rate_pct}%  judge ${out.judge_pass_pct}%  cost $${out.cost_usd.toFixed(6)}  p50 ${out.latency_p50_ms}ms`);
  console.log('-> results/escalate.json');
  return out;
}
