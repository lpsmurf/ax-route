// Cursor keeps per-request usage on its servers, not on disk. Detect the install so the audit can
// say so, rather than silently reporting zero.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './common.mjs';

export const tool = 'cursor';

export async function read(h = home()) {
  const installed = [
    join(h, 'Library', 'Application Support', 'Cursor'),
    join(h, '.config', 'Cursor'),
    join(h, 'AppData', 'Roaming', 'Cursor'),
    join(h, '.cursor'),
  ].some(existsSync);
  return installed
    ? { tool, status: 'unsupported', note: 'installed, but Cursor keeps usage server-side; reader not built yet', records: [] }
    : { tool, status: 'absent', records: [] };
}
