// Sweep the Token Factory catalogue to find the cheapest model that still passes.
//
// The point: a routing policy should be derived, not asserted. This runs the same
// fixtures against every candidate model, scores them identically, and reports the
// cost/quality frontier — so policy.yaml can name a model for a measured reason.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey } from './policy.mjs';
import { cost, table } from './price.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.studio.nebius.com/v1';
const JUDGE = 'deepseek-ai/DeepSeek-V4-Pro';

// Text-generation models only. Embedding and vision models cannot do these jobs, and
// superseded point-releases are skipped so the curve reads cleanly.
const EXCLUDE = [
  'Qwen/Qwen3-Embedding-8B',        // embedding
  'openbmb/MiniCPM-V-4_5',          // vision
  'zai-org/GLM-5.1', 'zai-org/GLM-5.2',          // superseded by GLM-5.3
  'deepseek-ai/DeepSeek-V4-Pro-0813',            // dated duplicate of DeepSeek-V4-Pro
];

export function candidates() {
  const nebius = table().nebius || {};
  return Object.entries(nebius)
    .filter(([id, p]) => !EXCLUDE.includes(id) && p.input > 0 && p.output > 0)
    .map(([id, p]) => ({ id, input: p.input, output: p.output }))
    .sort((a, b) => a.input - b.input);
}

const MAX_TOKENS = 1200; // Reasoning models emit a hidden scratchpad before answering.
// At a low ceiling they truncate mid-thought and score as though they were incapable,
// which measures the ceiling, not the model. Those tokens still count against their cost.
async function call(model, messages, max_tokens = MAX_TOKENS) {
  const key = apiKey('NEBIUS_API_KEY');
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens, temperature: 0 }),
    });
    const b = await r.json().catch(() => ({}));
    const u = b.usage || {};
    return {
      ok: r.status === 200,
      text: (b.choices?.[0]?.message?.content ?? '').trim(),
      latency_ms: Date.now() - t0,
      tokens: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cache_read: 0 },
    };
  } catch (e) {
    return { ok: false, text: '', latency_ms: Date.now() - t0, tokens: { input: 0, output: 0, cache_read: 0 }, error: e.message };
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[\s,$"'`*]/g, '');
const matched = (t, e) => norm(t).includes(norm(e));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const quantile = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function judge(fixture, answer) {
  const r = await call(JUDGE, [{ role: 'user', content:
`You are grading one answer against a rubric. Reply with exactly one word: PASS or FAIL.

Task:
${fixture.prompt}

Rubric:
${fixture.rubric}

Answer:
${answer || '(empty)'}

One word, PASS or FAIL:` }], 200);
  return /\bPASS\b/i.test(r.text) ? 'PASS' : 'FAIL';
}

export async function run({ bar = 90 } = {}) {
  const fx = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/mechanical.json'), 'utf8'));
  const fixtures = fx.fixtures;
  const models = candidates();
  console.log(`sweep: ${models.length} Token Factory models x ${fixtures.length} fixtures\n`);

  const results = [];
  for (const m of models) {
    process.stdout.write(`  ${m.id.padEnd(40)} `);
    const rows = await pool(fixtures, 6, async (f) => {
      const r = await call(m.id, [{ role: 'user', content: f.prompt }]);
      process.stdout.write(r.ok ? '.' : 'x');
      return { ...r, match: r.ok && matched(r.text, f.expect) };
    });
    const verdicts = await pool(rows, 6, (row, k) => judge(fixtures[k], row.text));
    rows.forEach((r, k) => { r.judge = verdicts[k]; });

    const tin = rows.reduce((s, r) => s + r.tokens.input, 0);
    const tout = rows.reduce((s, r) => s + r.tokens.output, 0);
    const c = cost(m.id, { input: tin, output: tout, cache_read: 0 });
    const lat = rows.filter((r) => r.ok).map((r) => r.latency_ms);
    const rec = {
      model: m.id,
      price_in: m.input, price_out: m.output,
      ok: rows.filter((r) => r.ok).length,
      match_pct: pct(rows.filter((r) => r.match).length, rows.length),
      judge_pct: pct(rows.filter((r) => r.judge === 'PASS').length, rows.length),
      tokens_in: tin, tokens_out: tout,
      cost_usd: c === null ? null : Number(c.toFixed(8)),
      cost_per_1k_tasks_usd: c === null ? null : Number((c / rows.length * 1000).toFixed(4)),
      latency_p50_ms: quantile(lat, 0.5),
      // Reasoning models spend output tokens on a scratchpad the caller never sees.
      // Cheap per token is not the same as cheap per task, and this is where that shows.
      output_tokens_per_task: Number((tout / rows.length).toFixed(1)),
      near_token_ceiling: (tout / rows.length) > MAX_TOKENS * 0.9,
    };
    results.push(rec);
    console.log(` match ${String(rec.match_pct).padStart(5)}%  judge ${String(rec.judge_pct).padStart(5)}%  $${rec.cost_per_1k_tasks_usd}/1k`);
  }

  const passing = results.filter((r) => r.judge_pct >= bar && r.cost_per_1k_tasks_usd !== null);
  passing.sort((a, b) => a.cost_per_1k_tasks_usd - b.cost_per_1k_tasks_usd);
  const winner = passing[0] || null;

  const out = {
    schema: 'route.sweep.v1',
    generated_at: new Date().toISOString(),
    provider: 'nebius token factory',
    base_url: BASE,
    fixtures: fixtures.length,
    max_tokens: MAX_TOKENS,
    max_tokens_note: 'Raised from 300 after a first pass truncated reasoning models mid-scratchpad and scored them as incapable. Their scratchpad tokens are still billed and still counted here.',
    fixtures_note: fx.note,
    judge: JUDGE,
    bar_judge_pct: bar,
    models_tested: results.length,
    results: results.sort((a, b) => (b.judge_pct - a.judge_pct) || (a.cost_per_1k_tasks_usd - b.cost_per_1k_tasks_usd)),
    cheapest_passing: winner,
    note: `The cheapest model scoring at or above ${bar}% on the blind judge. This is how policy.yaml picks its mechanical tier — measured, not asserted.`,
    source: 'bench/fixtures/mechanical.json + prices.yaml',
  };
  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/sweep.json'), JSON.stringify(out, null, 2));

  console.log(`\ncheapest model at or above ${bar}% judge pass:`);
  if (winner) {
    console.log(`  ${winner.model}  —  ${winner.judge_pct}% judge, $${winner.cost_per_1k_tasks_usd} per 1k tasks, p50 ${winner.latency_p50_ms}ms`);
    const dearest = results.filter(r => r.cost_per_1k_tasks_usd).sort((a,b)=>b.cost_per_1k_tasks_usd-a.cost_per_1k_tasks_usd)[0];
    console.log(`  vs dearest tested (${dearest.model}): ${(dearest.cost_per_1k_tasks_usd / winner.cost_per_1k_tasks_usd).toFixed(1)}x`);
  } else console.log('  none cleared the bar');
  console.log('\n-> results/sweep.json');
  return out;
}
