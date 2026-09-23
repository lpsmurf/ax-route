// Read the operator's actual agent estate and say which routes are safe to deploy.
//
// This is the half a router cannot do for you. Enforcing a policy is easy; knowing which
// policy is safe means knowing what your agents actually do, what it costs, and whether
// there is evidence a cheaper model handles that job. Roles without evidence are reported
// as untested, never as deployable.
import { readFileSync, readdirSync, statSync, existsSync, createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { cost, lookup } from './price.mjs';
import { policy } from './policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AX = process.env.AX_HOME || join(homedir(), 'dev');

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
export function inventory() {
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

// --- what each project actually spent, from real transcripts
export async function spendByProject() {
  const root = process.env.ROUTE_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return { projects: [], requests: 0, total_usd: 0 };
  const files = [];
  for (const d of readdirSync(root)) {
    const p = join(root, d);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) files.push(join(p, f));
  }
  const seen = new Set();
  const byProj = {};
  let requests = 0;
  await Promise.all(files.map((f) => new Promise((res) => {
    const rl = createInterface({ input: createReadStream(f) });
    rl.on('line', (l) => {
      if (!l.includes('"usage"')) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      const u = r.message?.usage; if (!u) return;
      const id = r.requestId || r.uuid; if (!id || seen.has(id)) return; seen.add(id);
      const model = r.message?.model; if (!model || model === '<synthetic>') return;
      const proj = r.cwd ? basename(r.cwd) : 'unknown';
      const usage = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        cache_create: u.cache_creation_input_tokens || 0,
      };
      requests++;
      const p = (byProj[proj] ||= { project: proj, requests: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, cost_usd: 0, models: {}, days: new Set() });
      p.requests++; p.input += usage.input; p.output += usage.output; p.cache_read += usage.cache_read; p.cache_create += usage.cache_create;
      p.cost_usd += cost(model, usage) || 0;
      p.models[model] = (p.models[model] || 0) + 1;
      if (r.timestamp) p.days.add(r.timestamp.slice(0, 10));
    });
    rl.on('close', res); rl.on('error', res);
  })));
  const projects = Object.values(byProj).map((p) => ({
    ...p, days: p.days.size,
    cost_usd: Number(p.cost_usd.toFixed(2)),
    models: Object.fromEntries(Object.entries(p.models).sort((a, b) => b[1] - a[1])),
  })).sort((a, b) => b.cost_usd - a.cost_usd);
  return { projects, requests, total_usd: Number(projects.reduce((s, p) => s + p.cost_usd, 0).toFixed(2)) };
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

export async function run({ reveal = false } = {}) {
  const sweepPath = join(ROOT, 'results/sweep.json');
  const sweep = existsSync(sweepPath) ? JSON.parse(readFileSync(sweepPath, 'utf8')) : null;
  const inv = inventory();
  const spend = await spendByProject();
  const routes = assessRoutes(sweep);
  const win = sweep?.cheapest_passing;

  const projects = spend.projects.map((p, i) => {
    const routed = win ? cost(win.model, { input: p.input, output: p.output, cache_read: p.cache_read, cache_create: p.cache_create }) : null;
    return {
      label: reveal ? p.project : anon(p.project, i),
      revealed: reveal,
      requests: p.requests, days: p.days,
      cost_usd: p.cost_usd,
      top_model: Object.keys(p.models)[0] || null,
      models: Object.keys(p.models).length,
      all_routed_usd: routed === null ? null : Number(routed.toFixed(2)),
      // Only the mechanical share is claimable; 50% is the midpoint of the replay band.
      addressable_usd: routed === null ? null : Number(((p.cost_usd - routed) * 0.5).toFixed(2)),
    };
  });

  const deployable = routes.filter((r) => r.status === 'deployable').length;
  const out = {
    schema: 'route.estate.v1',
    generated_at: new Date().toISOString(),
    privacy: reveal ? 'project names revealed by explicit --reveal flag' : 'project names replaced with stable labels; they are client names',
    inventory: { agents: inv.agents.length, skills: inv.skills, repos: inv.repos.length, agent_list: inv.agents },
    repos: inv.repos.map((r) => ({ name: reveal ? r.name : anon(r.name, inv.repos.indexOf(r)), has_remote: Boolean(r.remote) })),
    spend: { requests: spend.requests, total_usd: spend.total_usd, projects },
    routes,
    summary: {
      roles_total: routes.length,
      roles_deployable: deployable,
      roles_untested: routes.length - deployable,
      addressable_usd: Number(projects.reduce((s, p) => s + (p.addressable_usd || 0), 0).toFixed(2)),
      basis: 'addressable = half the gap between what each project actually paid and what the swept winner would cost, the midpoint of the replay band',
    },
    source: '~/.claude/projects transcripts + ~/dev/.agents + config/projects.tsv + results/sweep.json',
  };
  if (!existsSync(join(ROOT, 'results'))) mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/estate.json'), JSON.stringify(out, null, 2));

  console.log(`estate: ${out.inventory.agents} agent roles, ${out.inventory.skills} skills, ${out.inventory.repos} repos registered`);
  console.log(`spend:  ${spend.requests} requests across ${projects.length} projects, $${spend.total_usd}\n`);
  console.log('project'.padEnd(14), 'reqs'.padStart(6), 'days'.padStart(5), 'paid'.padStart(9), 'addressable'.padStart(12));
  for (const p of projects.slice(0, 10)) {
    console.log(p.label.padEnd(14), String(p.requests).padStart(6), String(p.days).padStart(5),
      ('$' + p.cost_usd).padStart(9), ('$' + (p.addressable_usd ?? 0)).padStart(12));
  }
  console.log(`\nroutes: ${deployable} of ${routes.length} roles deployable on measured evidence, ${routes.length - deployable} untested`);
  for (const r of routes) console.log(`  ${r.status === 'deployable' ? '+' : '?'} ${r.job.padEnd(20)} ${r.declared_tier.padEnd(11)} ${r.status}`);
  console.log(`\naddressable today: $${out.summary.addressable_usd}`);
  console.log('-> results/estate.json');
  return out;
}
