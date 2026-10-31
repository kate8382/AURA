import fs from 'fs/promises';
import path from 'path';

export const NOTICE_PATH = path.join(__dirname, '..', '..', 'real_cases', 'NOTICE.md');

// Returns the Source IDs listed in the "Approved sources" table of real_cases/NOTICE.md.
// Excluded sources are not returned, so cases cannot reference them.
export function parseApprovedSourceIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let inApproved = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      inApproved = /^##\s+Approved sources\s*$/i.test(line);
      continue;
    }
    if (!inApproved) continue;
    const match = /^\|\s*`([a-z0-9]+(?:-[a-z0-9]+)*)`\s*\|/.exec(line);
    if (match) ids.add(match[1]);
  }
  return ids;
}

export async function loadApprovedSourceIds(noticePath: string = NOTICE_PATH): Promise<Set<string>> {
  const markdown = await fs.readFile(noticePath, 'utf8');
  return parseApprovedSourceIds(markdown);
}
