#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const jsonPath = path.join(repoRoot, 'analytics', 'traffic-history.json');
  const csvPath = path.join(repoRoot, 'analytics', 'traffic-history.csv');
  const svgPath = path.join(repoRoot, 'analytics', 'traffic-history.svg');
  const readmePath = path.join(repoRoot, 'README.md');

  let data = [];
  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    data = JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Cannot read', jsonPath, e.message);
    process.exit(1);
  }

  // Aggregate totals across full history
  let totalViews = 0, totalUniqueViews = 0, totalClones = 0, totalUniqueClones = 0;
  for (const s of data) {
    totalViews += (s.views && s.views.count) || 0;
    totalUniqueViews += (s.views && s.views.uniques) || 0;
    totalClones += (s.clones && s.clones.count) || 0;
    totalUniqueClones += (s.clones && s.clones.uniques) || 0;
  }

  // Build CSV rows: date,total_views,unique_views,total_clones,unique_clones
  const rows = [['date','total_views','unique_views','total_clones','unique_clones']];
  for (const s of data) {
    const v = s.views || {};
    const c = s.clones || {};
    rows.push([s.date || '', String(v.count || 0), String(v.uniques || 0), String(c.count || 0), String(c.uniques || 0)]);
  }
  const csv = rows.map(r => r.join(',')).join('\n') + '\n';
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.writeFile(csvPath, csv, 'utf8');
  console.log('Wrote', csvPath);

  // Generate simple SVG plotting total_views over time
  const points = data.map((s, i) => ({ x: i, y: (s.views && s.views.count) || 0, date: s.date }));
  const width = 800;
  const height = 240;
  const padding = 40;
  const maxY = Math.max(1, ...points.map(p => p.y));

  function sx(x) { return padding + (x / Math.max(1, points.length - 1)) * (width - padding*2); }
  function sy(y) { return height - padding - (y / maxY) * (height - padding*2); }

  const poly = points.map(p => `${sx(p.x)},${sy(p.y)}`).join(' ');

  const svg = `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">\n  <rect width="100%" height="100%" fill="#fff"/>\n  <polyline fill="none" stroke="#2b8cbe" stroke-width="2" points="${poly}" />\n  <!-- X labels -->\n  ${points.map((p, i) => `<text x="${sx(p.x)}" y="${height - padding + 14}" font-size="10" text-anchor="middle">${p.date || ''}</text>`).join('\n  ')}\n  <!-- Y max -->\n  <text x="10" y="${padding}" font-size="12">max ${maxY}</text>\n</svg>\n`;

  await fs.writeFile(svgPath, svg, 'utf8');
  console.log('Wrote', svgPath);

  // Update README: replace or append section between markers
  let readme = '';
  try { readme = await fs.readFile(readmePath, 'utf8'); } catch (e) { readme = '# Project\n'; }

  const start = '<!-- TRAFFIC_CHART_START -->';
  const end = '<!-- TRAFFIC_CHART_END -->';
  const embed = `\n${start}\n\n## Traffic history\n\n- **Total views:** ${totalViews}\n- **Total unique views:** ${totalUniqueViews}\n- **Total clones:** ${totalClones}\n- **Total unique clones:** ${totalUniqueClones}\n\n![Traffic history](analytics/traffic-history.png)\n\nDownload data: [CSV](analytics/traffic-history.csv)\n\n${end}\n`;

  if (readme.includes(start) && readme.includes(end)) {
    const before = readme.split(start)[0];
    const after = readme.split(end)[1] || '';
    readme = before + embed + after;
  } else {
    // insert near Integration & Partnerships if present
    const anchor = '## Integration & Partnerships';
    const license = '## License & Tooling';
    if (readme.includes(anchor) && readme.includes(license)) {
      const parts = readme.split(license);
      readme = parts[0] + embed + license + parts[1];
    } else {
      if (!readme.endsWith('\n')) readme += '\n';
      readme += embed;
    }
  }

  await fs.writeFile(readmePath, readme, 'utf8');
  console.log('Updated README with traffic embed');
}

main().catch(err => { console.error(err); process.exit(1); });
