import fs from 'fs/promises';
import path from 'path';

export const NOTICE_PATH = path.join(__dirname, '..', '..', 'real_cases', 'NOTICE.md');

export interface NoticeSources {
  // "Approved sources": may be used as Full Text, Excerpt, or Pointer Only.
  approved: Set<string>;
  // "Conditional Sources (Pointer Only)": may only be stored as pointer_only.
  conditional: Set<string>;
}

const CONDITIONAL_HEADING = 'Conditional Sources (Pointer Only)';

// Returns the Source IDs listed in the table under the given "## " heading of real_cases/NOTICE.md.
// Excluded sources are not returned, so cases cannot reference them.
function parseSectionIds(markdown: string, heading: string): Set<string> {
  const ids = new Set<string>();
  let inSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) {
      inSection = h[1].toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const match = /^\|\s*`([a-z0-9]+(?:-[a-z0-9]+)*)`\s*\|/.exec(line);
    if (match) ids.add(match[1]);
  }
  return ids;
}

export function parseNoticeSources(markdown: string): NoticeSources {
  return {
    approved: parseSectionIds(markdown, 'Approved sources'),
    conditional: parseSectionIds(markdown, CONDITIONAL_HEADING)
  };
}

export async function loadNoticeSources(noticePath: string = NOTICE_PATH): Promise<NoticeSources> {
  const markdown = await fs.readFile(noticePath, 'utf8');
  return parseNoticeSources(markdown);
}
