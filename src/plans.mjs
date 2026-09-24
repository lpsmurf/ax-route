// How the operator pays for each tool. The logs say which tools ran and sometimes which plan; only
// the operator knows the fee. The questionnaire asks once, stores the answers outside the repo, and
// the audit turns them into a monthly bill and what it would be with Route.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parsePrices } from './price.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let CATALOG = null;
export const catalog = () => (CATALOG ||= parsePrices(readFileSync(join(ROOT, 'plans.yaml'), 'utf8')));

export const answersPath = (home) =>
  join(home ? join(home, '.config') : process.env.XDG_CONFIG_HOME || join(process.env.ROUTE_HOME || homedir(), '.config'), 'ax-route', 'plans.json');

// { tool: { billing, tier?, usd_month? } | null }. null = the operator chose to skip that tool.
export function loadAnswers(home) {
  try { return JSON.parse(readFileSync(answersPath(home), 'utf8')).tools || {}; } catch { return null; }
}

export function saveAnswers(home, tools) {
  const p = answersPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ schema: 'route.plans.v1', saved_at: new Date().toISOString(), tools }, null, 2) + '\n');
  return p;
}

// The plan hint a tool logs ("plus", "default_claude_max_20x") → a catalog tier, only if unambiguous.
export function detectTier(tool, hint) {
  if (!hint) return null;
  const tiers = Object.keys(catalog()[tool] || {});
  const h = String(hint).toLowerCase().replace(/_/g, '-');
  if (tiers.includes(h)) return h;
  const hits = tiers.filter((k) => h.endsWith(`-${k}`)).concat(tiers.filter((k) => k.startsWith(`${h}-`)));
  return hits.length === 1 ? hits[0] : null;
}

// Who pays for a record: the plan it rides (Hermes on Codex), else the tool that made it.
export const payer = (r) => r.plan_via || r.tool;

export function payers(records) {
  const out = {};
  for (const r of records) {
    if (r.billing === 'local') continue;
    const k = (out[payer(r)] ||= { requests: 0, tools: new Set(), billing: {} });
    k.requests += r.requests; k.tools.add(r.tool);
    k.billing[r.billing] = (k.billing[r.billing] || 0) + r.requests;
  }
  return out;
}

// prompt(question) → Promise<string>. Only the payers in `ask` are asked; the rest keep `answers`.
export async function questionnaire({ records, sources, prompt, answers = {}, ask, print = console.log }) {
  const found = payers(records);
  const keys = Object.keys(found).filter((k) => !ask || ask.includes(k));
  if (!keys.length) return answers;
  const out = { ...answers };
  print('\nHow do you pay for each tool? Press Enter to accept [the default]. Asked once; change later with `route plans`.');
  for (const tool of keys) {
    const k = found[tool];
    const tiers = Object.entries(catalog()[tool] || {});
    const hint = sources.find((s) => s.tool === tool)?.plan;
    const detected = detectTier(tool, hint);
    const opts = [
      ...tiers.map(([id, t]) => ({ label: `${t.label.padEnd(30)} $${t.usd}/month`, answer: { billing: 'subscription', tier: id, usd_month: t.usd } })),
      { label: tiers.length ? 'another plan — enter $/month' : 'a subscription — enter $/month', custom: true },
      { label: 'API key — pay per token', answer: { billing: 'api' } },
      { label: 'skip', answer: null },
    ];
    const mostly = Object.entries(k.billing).sort((a, b) => b[1] - a[1])[0]?.[0];
    const def = detected ? tiers.findIndex(([id]) => id === detected) + 1
      : mostly === 'api' ? opts.length - 1 : opts.length;
    const via = [...k.tools].filter((t) => t !== tool);
    print(`\n${tool} — ${k.requests.toLocaleString('en-US')} requests${via.length ? ` (incl. ${via.join(', ')})` : ''}${hint ? `, logs say plan "${hint}"` : ''}`);
    opts.forEach((o, i) => print(`  ${i + 1}) ${o.label}`));
    let n;
    for (;;) {
      const a = String(await prompt(`choice [${def}]: `)).trim();
      n = a ? Number(a) : def;
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) break;
      print(`  pick a number from 1 to ${opts.length}`);
    }
    const o = opts[n - 1];
    if (!o.custom) { out[tool] = o.answer; continue; }
    for (;;) {
      const a = String(await prompt('  monthly fee in USD: ')).trim().replace(/^\$/, '');
      const usd = Number(a);
      if (a && Number.isFinite(usd) && usd >= 0) { out[tool] = { billing: 'subscription', tier: 'custom', usd_month: usd }; break; }
      print('  enter a number, e.g. 20');
    }
  }
  return out;
}

// One plan's verdict for the month. `p` carries fee and last-30-day API-equivalent value.
//   overpaying  paying per token with Route would cost less than the fee
//   downgrade   the plan's own limit data says a smaller tier fits once Route offloads work
//   at-limits   the plan is worth it but capacity is the constraint; Route frees headroom
//   pays-off    the plan is worth more than it costs and is not near its limits
export function verdict({ tool, tier, fee, value, routed, unpricedShare, limits }) {
  if (fee === null || fee === undefined) return { kind: 'no-fee', with_route: null };
  if (unpricedShare > 0.2) return { kind: 'unpriced', with_route: fee };
  if (routed < fee) return { kind: 'overpaying', with_route: routed };
  const peak = limits ? Math.max(limits.primary?.peak_30d || 0, limits.secondary?.peak_30d || 0) / 100 : null;
  const offload = value ? 1 - routed / value : 0;
  const cur = catalog()[tool]?.[tier];
  if (peak !== null && cur?.x) {
    // Keep a 25% margin: the smaller plan must hold the peak after offload with room to spare.
    const need = peak * (1 - offload) * cur.x * 1.25;
    const fit = Object.entries(catalog()[tool]).filter(([, t]) => t.x && t.x >= need && t.usd < fee).sort((a, b) => a[1].usd - b[1].usd)[0];
    if (fit) return { kind: 'downgrade', with_route: fit[1].usd, to: fit[0], to_label: fit[1].label };
  }
  if (peak !== null && peak >= 0.9) return { kind: 'at-limits', with_route: fee, peak, offload };
  return { kind: 'pays-off', with_route: fee, multiple: fee ? value / fee : null };
}
