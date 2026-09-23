// Re-price real historical agent work under the policy.
//
// Reads local Claude Code transcripts, dedupes on requestId, prices every request at the
// published rate, and reports what the same tokens would have cost routed to Token Factory.
//
// Privacy: aggregates only. Project names, cwd paths and prompt text never leave this
// process — the committed output carries counts, tokens and dollars, nothing identifying.
import { createReadStream, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { cost, lookup } from './price.mjs';
import { policy } from './policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function transcripts() {
  const root = process.env.ROUTE_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  const out = [];
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    const p = join(root, d);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) out.push(join(p, f));
  }
  return out;
}

export async function collect() {
  const files = transcripts();
  const seen = new Set();
  const byModel = {};
  const byDay = {};
  let requests = 0;
  await Promise.all(files.map((f) => new Promise((res) => {
    const rl = createInterface({ input: createReadStream(f) });
    rl.on('line', (l) => {
      if (!l.includes('"usage"')) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      const u = r.message?.usage; if (!u) return;
      const id = r.requestId || r.uuid; if (!id || seen.has(id)) return; seen.add(id);
      const model = r.message?.model; if (!model || model === '<synthetic>') return;
      const day = (r.timestamp || '').slice(0, 10); if (!day) return;
      const t = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        cache_create: u.cache_creation_input_tokens || 0,
      };
      requests++;
      const m = (byModel[model] ||= { requests: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 });
      m.requests++; m.input += t.input; m.output += t.output; m.cache_read += t.cache_read; m.cache_create += t.cache_create;
      const d = (byDay[day] ||= { requests: 0, cost_usd: 0 });
      d.requests++;
      d.cost_usd += cost(model, { input: t.input, output: t.output, cache_read: t.cache_read, cache_create: t.cache_create }) || 0;
    });
    rl.on('close', res); rl.on('error', res);
  })));
  return { files: files.length, requests, byModel, byDay };
}

export async function run() {
  const { files, requests, byModel, byDay } = await collect();
  const p = policy();
  const routedModel = p.tiers.mechanical.model;

  let actual = 0, unpriced = 0;
  const models = [];
  for (const [model, m] of Object.entries(byModel)) {
    const usage = { input: m.input, output: m.output, cache_read: m.cache_read, cache_create: m.cache_create };
    const c = cost(model, usage);
    if (c === null) unpriced += m.requests; else actual += c;
    models.push({
      model, requests: m.requests, share_pct: Number((m.requests / requests * 100).toFixed(2)),
      tokens_in: usage.input, tokens_out: usage.output, cache_read: usage.cache_read, cache_create: usage.cache_create,
      cost_usd: c === null ? null : Number(c.toFixed(4)),
      priced: c !== null,
    });
  }
  models.sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));

  // Counterfactual. Routing every token is not a claim anyone should believe, so this is a
  // sensitivity band: what the bill becomes if that share of work had gone to Token Factory.
  const totalUsage = models.reduce((s, m) => ({
    input: s.input + m.tokens_in, output: s.output + m.tokens_out,
    cache_read: s.cache_read + m.cache_read, cache_create: s.cache_create + (m.cache_create || 0),
  }), { input: 0, output: 0, cache_read: 0, cache_create: 0 });
  const allRouted = cost(routedModel, totalUsage);
  const band = [0.25, 0.5, 0.75].map((share) => {
    const routed = allRouted * share + actual * (1 - share);
    return {
      mechanical_share: share,
      cost_usd: Number(routed.toFixed(2)),
      saved_usd: Number((actual - routed).toFixed(2)),
      saved_pct: Number(((actual - routed) / actual * 100).toFixed(1)),
    };
  });

  const days = Object.keys(byDay).sort();
  const haiku = models.filter((m) => m.model.includes('haiku')).reduce((s, m) => s + m.requests, 0);

  const out = {
    schema: 'route.replay.v1',
    generated_at: new Date().toISOString(),
    source: '~/.claude/projects/**/*.jsonl (local Claude Code transcripts, deduped on requestId)',
    privacy: 'aggregates only — no project names, paths or prompt text',
    window: { first_day: days[0] || null, last_day: days.at(-1) || null, days: days.length },
    transcripts: files,
    requests,
    unpriced_requests: unpriced,
    actual_cost_usd: Number(actual.toFixed(2)),
    by_model: models,
    // The policy declares three of eight job types mechanical. This is how often the
    // cheapest tier actually ran.
    cheapest_tier_requests: haiku,
    cheapest_tier_share_pct: Number((haiku / requests * 100).toFixed(3)),
    routed_model: routedModel,
    routed_price: lookup(routedModel),
    all_routed_cost_usd: Number(allRouted.toFixed(2)),
    counterfactual_band: band,
    band_note: 'Scenario, not a measurement. Shows the bill if that share of tokens had been routed to Token Factory at published rates; the rest stays on the model that actually ran.',
  };

  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/replay.json'), JSON.stringify(out, null, 2));

  console.log(`replay: ${files} transcripts, ${requests} deduped requests, ${days.length} days (${days[0]} -> ${days.at(-1)})`);
  console.log(`actual cost at published rates: $${actual.toFixed(2)}`);
  console.log(`cheapest declared tier ran ${haiku} of ${requests} requests (${(haiku / requests * 100).toFixed(2)}%)\n`);
  console.log('model'.padEnd(30), 'reqs'.padStart(6), 'share%'.padStart(7), 'cost'.padStart(10));
  for (const m of models.slice(0, 8)) {
    console.log(m.model.padEnd(30), String(m.requests).padStart(6), String(m.share_pct).padStart(7), (m.cost_usd === null ? '(unpriced)' : '$' + m.cost_usd.toFixed(2)).padStart(10));
  }
  console.log(`\nif routed to ${routedModel}:`);
  for (const b of band) console.log(`  ${(b.mechanical_share * 100).toFixed(0)}% mechanical -> $${b.cost_usd} (saves $${b.saved_usd}, ${b.saved_pct}%)`);
  console.log('\n-> results/replay.json');
  return out;
}
