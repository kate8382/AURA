#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const jsonPath = path.join(repoRoot, 'analytics', 'traffic-history.json');
  const outPath = path.join(repoRoot, 'analytics', 'traffic-summary.json');

  let data = [];
  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    data = JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Cannot read', jsonPath, e.message);
    process.exit(1);
  }

  let totalViews = 0, totalUniqueViews = 0, totalClones = 0, totalUniqueClones = 0;
  for (const s of data) {
    totalViews += (s.views && s.views.count) || 0;
    totalUniqueViews += (s.views && s.views.uniques) || 0;
    totalClones += (s.clones && s.clones.count) || 0;
    totalUniqueClones += (s.clones && s.clones.uniques) || 0;
  }

  const summary = {
    total_views: totalViews,
    total_unique_views: totalUniqueViews,
    total_clones: totalClones,
    total_unique_clones: totalUniqueClones
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('Wrote', outPath, '->', JSON.stringify(summary));
}

main().catch(err => { console.error(err); process.exit(1); });
