import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as kimi from './kimi.mjs';
import * as hermes from './hermes.mjs';
import * as openclaw from './openclaw.mjs';
import * as cursor from './cursor.mjs';

export const SOURCES = [claude, codex, kimi, hermes, openclaw, cursor];
export const TOOLS = SOURCES.map((s) => s.tool);
const ALIAS = { claude: 'claude-code', 'kimi-code': 'kimi' };
export const toolName = (s) => ALIAS[s] || s;

// One broken reader must not sink the audit; it reports its own error and the rest carry on.
export function collect({ only, home } = {}) {
  const picked = only?.length ? SOURCES.filter((s) => only.map(toolName).includes(s.tool)) : SOURCES;
  return Promise.all(picked.map(async (s) => {
    try { return await s.read(home); } catch (e) { return { tool: s.tool, status: 'error', note: e.message, records: [] }; }
  }));
}
