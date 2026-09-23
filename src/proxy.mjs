// OpenAI-compatible routing endpoint.
//
// The response body is passed through untouched, so any OpenAI client works unmodified.
// Route's only additions are the routing decision and the ledger line it leaves behind.
import { createServer } from 'node:http';
import { resolve as resolveJob, apiKey, jobs } from './policy.mjs';
import { cost } from './price.mjs';
import { append } from './ledger.mjs';

const readBody = (req) => new Promise((ok, fail) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', fail);
});

// A job arrives as the x-route-job header, or as a "route/<job>" model alias.
export function jobFrom(req, body) {
  const header = req.headers['x-route-job'];
  if (header) return String(header);
  const m = typeof body?.model === 'string' && body.model.match(/^route\/(.+)$/);
  return m ? m[1] : null;
}

export async function handleCompletion(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
  }

  const job = jobFrom(req, body);
  const decision = resolveJob(job);
  const key = apiKey(decision.key_env);
  if (!key) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: {
      message: `no credential for ${decision.key_env}. Set the env var, or add it to the macOS Keychain: security add-generic-password -a "$USER" -s ${decision.key_env} -w`,
    } }));
  }

  const upstream = { ...body, model: decision.model };
  const started = Date.now();
  let out, status = 502, usage = null;
  try {
    const r = await fetch(`${decision.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(upstream),
    });
    status = r.status;
    out = await r.text();
    try { usage = JSON.parse(out).usage || null; } catch { /* non-JSON upstream error */ }
  } catch (e) {
    out = JSON.stringify({ error: { message: `upstream ${decision.provider} unreachable: ${e.message}` } });
  }
  const latency_ms = Date.now() - started;

  const tokens = usage ? {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    cache_read: usage.prompt_tokens_details?.cached_tokens ?? 0,
  } : null;

  append({
    job: decision.job,
    known_job: decision.known,
    tier: decision.tier,
    model: decision.model,
    provider: decision.provider,
    region: decision.region,
    status,
    latency_ms,
    tokens,
    cost_usd: tokens ? cost(decision.model, tokens) : null,
    outcome: status >= 200 && status < 300 ? 'ok' : 'error',
  });

  res.writeHead(status, {
    'content-type': 'application/json',
    'x-route-model': decision.model,
    'x-route-tier': decision.tier,
    'x-route-provider': decision.provider,
  });
  res.end(out);
}

export function serve(port = Number(process.env.ROUTE_PORT) || 8787) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return handleCompletion(req, res);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, jobs: jobs() }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
  });
  server.listen(port, () => {
    console.log(`route listening on http://localhost:${port}`);
    console.log(`  POST /v1/chat/completions   header: x-route-job: <${jobs()[0]}|...>`);
  });
  return server;
}
