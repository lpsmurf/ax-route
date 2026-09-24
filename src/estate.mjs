// Read the operator's actual agent estate and say which routes are safe to deploy.
//
// This is the half a router cannot do for you. Enforcing a policy is easy; knowing which
// policy is safe means knowing what your agents actually do, what it costs, and whether
// there is evidence a cheaper model handles that job. Roles without evidence are reported
// as untested, never as deployable.
//
// Spend is read from every agent tool on the machine (src/sources/) and split by how the operator
// pays: pay-per-token spend is real money and can be overspent; a flat subscription costs nothing
// per token, so its usage is shown at API-equivalent value and against the plan's rate limits.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { cost, lookup } from './price.mjs';
import { policy } from './policy.mjs';
import { collect, toolName } from './sources/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const axHome = (home) => process.env.AX_HOME || join(home || process.env.ROUTE_HOME || homedir(), 'dev');

const frontmatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

// --- the estate: agents, skills, repos the operator actually has
export function inventory(AX = axHome()) {
  const agents = [];
  const dir = join(AX, '.agents', 'agents');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const fm = frontmatter(readFileSync(join(dir, f), 'utf8'));
      agents.push({ name: fm.name || basename(f, '.md'), declared_model: fm.model || null, description: (fm.description || '').slice(0, 160) });
    }
  }
  const skillsDir = join(AX, '.agents', 'skills');
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => !d.startsWith('.')).length : 0;

  const repos = [];
  const tsv = join(AX, 'config', 'projects.tsv');
  if (existsSync(tsv)) {
    for (const line of readFileSync(tsv, 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [name, remote] = line.split('\t');
      if (name) repos.push({ name: name.trim(), remote: (remote || '').trim() || null });
    }
  }
  return { agents, skills, repos };
}

// --- price a record. Local models cost nothing; an unpriced model stays null, never a guess.
const tokens = (r) => r.input + r.output + r.cache_read + r.cache_create;
const listPrice = (model, usage) => {
  const c = cost(model, usage);
  // Model-agnostic tools prefix the provider (openrouter/anthropic/claude-…); retry on the bare id.
  return c === null && model.includes('/') ? cost(model.split('/').pop(), usage) : c;
};
function value(r, win) {
  if (r.billing === 'local') return { worth: 0, routed: null };
  const usage = { input: r.input, output: r.output, cache_read: r.cache_read, cache_create: r.cache_create };
  const listed = listPrice(r.model, usage);
  // Pay-per-token: what the tool says was charged beats our list price. Otherwise the list price.
  const worth = r.billing === 'api' ? (r.reported_usd ?? listed) : (listed ?? r.reported_usd);
  return { worth: worth ?? null, routed: worth !== null && win ? cost(win.model, usage) : null };
}

// --- what each tool and project actually used, split by billing mode
export function aggregate(records, win) {
  const tools = {}, projects = {}, plans = {};
  for (const r of records) {
    const { worth, routed } = value(r, win);
    const paid = r.billing === 'api' ? worth ?? 0 : 0;
    const equiv = r.billing === 'api' || r.billing === 'local' ? 0 : worth ?? 0;
    // Only the mechanical share is claimable; 50% is the midpoint of the replay band.
    const gap = worth !== null && routed !== null ? Math.max(0, worth - routed) * 0.5 : 0;
    const t = (tools[r.tool] ||= { tool: r.tool, requests: 0, tokens: 0, paid_usd: 0, equiv_usd: 0, unpriced_tokens: 0, local_tokens: 0, billing: {}, days: new Set(), models: {} });
    t.requests += r.requests; t.tokens += tokens(r); t.paid_usd += paid; t.equiv_usd += equiv;
    if (worth === null) t.unpriced_tokens += tokens(r);
    if (r.billing === 'local') t.local_tokens += tokens(r);
    t.billing[r.billing] = (t.billing[r.billing] || 0) + r.requests;
    t.models[r.model] = (t.models[r.model] || 0) + r.requests;
    if (r.day) t.days.add(r.day);
    const p = (projects[r.project] ||= { project: r.project, requests: 0, paid_usd: 0, equiv_usd: 0, addressable_usd: 0, offloadable_usd: 0, tools: new Set(), models: {}, days: new Set() });
    p.requests += r.requests; p.paid_usd += paid; p.equiv_usd += equiv;
    if (r.billing === 'api') p.addressable_usd += gap; else p.offloadable_usd += gap;
    p.tools.add(r.tool);
    p.models[r.model] = (p.models[r.model] || 0) + r.requests;
    if (r.day) p.days.add(r.day);
    if (r.billing === 'subscription') {
      const key = r.plan_via || r.tool;
      const s = (plans[key] ||= { plan: key, requests: 0, equiv_usd: 0, unpriced_tokens: 0, tools: new Set(), days: new Set() });
      s.requests += r.requests; s.equiv_usd += equiv; s.tools.add(r.tool);
      if (worth === null) s.unpriced_tokens += tokens(r);
      if (r.day) s.days.add(r.day);
    }
  }
  const r2 = (n) => Number(n.toFixed(2));
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const span = (days) => {
    const d = [...days].sort();
    return d.length ? { first: d[0], last: d.at(-1), days: Math.round((Date.parse(d.at(-1)) - Date.parse(d[0])) / 864e5) + 1 } : null;
  };
  return {
    tools: Object.values(tools).map((t) => ({
      ...t, paid_usd: r2(t.paid_usd), equiv_usd: r2(t.equiv_usd), active_days: t.days.size, span: span(t.days),
      days: undefined, models: top(t.models),
      mode: top(t.billing)[0] || 'unknown',
    })).sort((a, b) => b.paid_usd + b.equiv_usd - (a.paid_usd + a.equiv_usd)),
    projects: Object.values(projects).map((p) => ({
      ...p, paid_usd: r2(p.paid_usd), equiv_usd: r2(p.equiv_usd), addressable_usd: r2(p.addressable_usd), offloadable_usd: r2(p.offloadable_usd),
      tools: [...p.tools], days: p.days.size, top_model: top(p.models)[0] || null, models: Object.keys(p.models).length,
    })).sort((a, b) => b.paid_usd + b.equiv_usd - (a.paid_usd + a.equiv_usd)),
    plans: Object.values(plans).map((s) => ({ ...s, equiv_usd: r2(s.equiv_usd), tools: [...s.tools], span: span(s.days), days: undefined }))
      .sort((a, b) => b.equiv_usd - a.equiv_usd),
  };
}

// --- subscriptions: value received against the fee, and how hard the plan's limits are hit
function subscriptions(plans, sources, fees) {
  return plans.map((p) => {
    const src = sources.find((s) => s.tool === p.plan) || {};
    const fee = fees[p.plan] ?? null;
    const months = p.span ? p.span.days / 30 : null;
    return {
      tool: p.plan, used_by: p.tools, tier: src.plan || null, requests: p.requests, equiv_usd: p.equiv_usd,
      unpriced_tokens: p.unpriced_tokens, span: p.span,
      fee_usd_month: fee,
      fee_usd_period: fee !== null && months ? Number((fee * months).toFixed(2)) : null,
      value_multiple: fee && months ? Number((p.equiv_usd / (fee * months)).toFixed(1)) : null,
      limits: src.limits || null,
    };
  });
}

// --- which routes the evidence actually supports
export function assessRoutes(sweep) {
  const p = policy();
  // The fixtures cover these job types only. Everything else is untested, and says so.
  const TESTED = new Set(['memory-retrieval', 'learning-extractor', 'qa-test']);
  const win = sweep?.cheapest_passing || null;
  return Object.entries(p.jobs || {}).map(([job, cfg]) => {
    const tier = p.tiers[cfg.tier];
    const tested = TESTED.has(job);
    return {
      job,
      declared_tier: cfg.tier,
      was: cfg.was || null,
      target_model: tier?.model || null,
      provider: tier?.provider || null,
      status: tested ? 'deployable' : 'untested',
      evidence: tested && win
        ? `${win.judge_pct}% blind-judge pass at $${win.cost_per_1k_tasks_usd}/1k tasks, ${sweep.models_tested}-model sweep`
        : 'no fixtures for this job type yet — not claimed as safe',
      price: tier?.model ? lookup(tier.model) : null,
    };
  });
}

const anon = (name, i) => {
  // Project names are client names. The published estate carries a stable label, not the name.
  const initials = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  return `${initials || 'P'}-${String(i + 1).padStart(2, '0')}`;
};

const usd = (n) => (n === null || n === undefined ? '-' : '$' + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)));
const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const win_ = (m) => (m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`);

// plans: { tool: monthly fee USD }; billing: { tool: api|subscription|local } overrides detection.
export async function run({ reveal = false, only, plans = {}, billing = {}, home, out: outPath = join(ROOT, 'results/estate.json'), print = true } = {}) {
  const sweepPath = join(ROOT, 'results/sweep.json');
  const sweep = existsSync(sweepPath) ? JSON.parse(readFileSync(sweepPath, 'utf8')) : null;
  const inv = inventory(axHome(home));
  const sources = await collect({ only, home });
  const override = Object.fromEntries(Object.entries(billing).map(([k, v]) => [toolName(k), v]));
  const fees = Object.fromEntries(Object.entries(plans).map(([k, v]) => [toolName(k), v]));
  const records = sources.flatMap((s) => (override[s.tool] ? s.records.map((r) => ({ ...r, billing: override[s.tool] })) : s.records));
  const routes = assessRoutes(sweep);
  const win = sweep?.cheapest_passing;
  const agg = aggregate(records, win);
  const projects = agg.projects.map((p, i) => ({ ...p, label: reveal ? p.project : anon(p.project, i), revealed: reveal, project: undefined, cost_usd: p.paid_usd }));
  const subs = subscriptions(agg.plans, sources, fees);
  const sum = (k, xs = agg.tools) => Number(xs.reduce((s, x) => s + (x[k] || 0), 0).toFixed(2));
  const deployable = routes.filter((r) => r.status === 'deployable').length;
  const harness = inv.agents.length + inv.skills + inv.repos.length > 0;

  const out = {
    schema: 'route.estate.v2',
    generated_at: new Date().toISOString(),
    privacy: reveal ? 'project names revealed by explicit --reveal flag' : 'project names replaced with stable labels; they are client names',
    sources: sources.map((s) => ({ tool: s.tool, status: s.status, note: s.note, files: s.files, plan: s.plan || null, records: s.records.length })),
    tools: agg.tools,
    inventory: harness ? { agents: inv.agents.length, skills: inv.skills, repos: inv.repos.length, agent_list: inv.agents } : null,
    repos: inv.repos.map((r, i) => ({ name: reveal ? r.name : anon(r.name, i), has_remote: Boolean(r.remote) })),
    spend: { requests: sum('requests'), total_usd: sum('paid_usd'), equiv_usd: sum('equiv_usd'), projects },
    subscriptions: subs,
    routes,
    summary: {
      roles_total: routes.length,
      roles_deployable: deployable,
      roles_untested: routes.length - deployable,
      addressable_usd: sum('addressable_usd', projects),
      offloadable_equiv_usd: sum('offloadable_usd', projects),
      basis: 'addressable = half the gap between what pay-per-token usage cost and what the swept winner would cost, the midpoint of the replay band. offloadable = the same gap on subscription usage at API-equivalent prices: it frees plan limits, not cash',
    },
    source: 'local agent logs (src/sources/) + results/sweep.json' + (harness ? ' + AX harness inventory' : ''),
  };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
  if (!print) return out;

  const found = out.sources.map((s) => (s.status === 'ok' ? `${s.tool} ${s.records}` : s.status === 'absent' ? null : `${s.tool} (${s.note || s.status})`)).filter(Boolean);
  console.log(`sources: ${found.join(' · ') || 'none'}`);
  if (!records.length) {
    console.log('\nno agent usage found on this machine. Route reads Claude Code, Codex, Kimi Code, Hermes and OpenClaw logs.');
    return out;
  }
  if (harness) console.log(`estate:  ${inv.agents.length} agent roles, ${inv.skills} skills, ${inv.repos.length} repos registered`);
  console.log(`usage:   ${out.spend.requests.toLocaleString('en-US')} requests across ${projects.length} projects\n`);

  console.log('tool'.padEnd(12), 'billing'.padEnd(13), 'reqs'.padStart(7), 'tokens'.padStart(8), 'paid'.padStart(9), 'api-equiv'.padStart(10), 'unpriced'.padStart(9));
  for (const t of agg.tools) {
    console.log(t.tool.padEnd(12), t.mode.padEnd(13), String(t.requests).padStart(7), tok(t.tokens).padStart(8),
      usd(t.paid_usd).padStart(9), usd(t.equiv_usd).padStart(10), (t.unpriced_tokens ? tok(t.unpriced_tokens) : '-').padStart(9));
  }

  if (subs.length) {
    console.log('\nsubscriptions — flat fee, $0 per token:');
    for (const s of subs) {
      const period = s.span ? ` over ${s.span.days} days` : '';
      const fee = s.fee_usd_month === null ? `fee not set (--plan ${s.tool}=<USD/month>)` : `fee ${usd(s.fee_usd_period)} → ${s.value_multiple}x value`;
      const worth = `worth ${usd(s.equiv_usd)} at API prices` + (s.unpriced_tokens ? ` + ${tok(s.unpriced_tokens)} unpriced tokens` : '');
      const via = s.used_by.length > 1 || s.used_by[0] !== s.tool ? ` (used by ${s.used_by.join(', ')})` : '';
      console.log(`  ${s.tool.padEnd(12)} ${s.tier ? `tier ${s.tier} · ` : ''}${worth}${period} · ${fee}${via}`);
      const l = s.limits;
      if (l) {
        const w = [l.primary, l.secondary].filter(Boolean).map((x) => `${win_(x.window_minutes)} ${x.used_percent}% (peak ${x.peak_30d}%)`);
        console.log(`  ${''.padEnd(12)} limits as of ${String(l.as_of).slice(0, 10)}: ${w.join(' · ')}`);
      }
    }
  }

  console.log('\n' + 'project'.padEnd(14), 'tools'.padEnd(22), 'reqs'.padStart(6), 'days'.padStart(5), 'paid'.padStart(9), 'api-equiv'.padStart(10), 'movable'.padStart(9));
  for (const p of projects.slice(0, 10)) {
    console.log(p.label.slice(0, 14).padEnd(14), p.tools.join(',').slice(0, 22).padEnd(22), String(p.requests).padStart(6), String(p.days).padStart(5),
      usd(p.paid_usd).padStart(9), usd(p.equiv_usd).padStart(10), usd(p.addressable_usd + p.offloadable_usd).padStart(9));
  }
  console.log(`\nroutes: ${deployable} of ${routes.length} roles deployable on measured evidence, ${routes.length - deployable} untested`);
  for (const r of routes) console.log(`  ${r.status === 'deployable' ? '+' : '?'} ${r.job.padEnd(20)} ${r.declared_tier.padEnd(11)} ${r.status}`);
  console.log(`\noverspend today (pay-per-token):        ${usd(out.summary.addressable_usd)}`);
  console.log(`offloadable (subscriptions, API prices): ${usd(out.summary.offloadable_equiv_usd)}  — frees plan limits, not cash`);
  if (outPath) console.log(`-> ${outPath.startsWith(ROOT) && !ROOT.includes('node_modules') ? outPath.slice(ROOT.length + 1) : outPath}`);
  return out;
}
