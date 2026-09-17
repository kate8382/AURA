#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const jsonPath = path.join(repoRoot, 'analytics', 'traffic-history.json');

  let current = [];
  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    current = JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Cannot read', jsonPath, e.message);
    process.exit(1);
  }

  if (!Array.isArray(current) || current.length === 0) {
    console.error('No snapshots found in', jsonPath);
    process.exit(1);
  }

  // find the latest snapshot by date
  const latest = current.reduce((a, b) => (a.date > b.date ? a : b));

  const viewsList = (latest.views && latest.views.per_day) || [];
  const clonesList = (latest.clones && latest.clones.per_day) || [];

  // helper to get yyyy-mm-dd from different possible keys
  const dayFrom = (item) => {
    if (!item) return null;
    const t = item.timestamp || item.date || item.day || item[0];
    if (!t) return null;
    // if it's a numeric timestamp (seconds or ms), convert to ISO
    if (typeof t === 'number' || String(Number(t)) === String(t)) {
      const n = Number(t);
      // detect seconds vs milliseconds (timestamps > 1e12 are ms)
      const ms = n > 1e12 ? n : n * 1000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    return String(t).slice(0, 10);
  };

  const map = new Map();
  const today = new Date().toISOString().slice(0, 10);
  // prefill with existing dates
  // Skip any entries that look like raw API snapshots containing per_day arrays
  for (const s of current) {
    if (!s || !s.date) continue;
    const hasPerDay = (s.views && s.views.per_day) || (s.clones && s.clones.per_day);
    if (hasPerDay) continue;
    // skip future dates (sometimes API snapshots include future-looking days)
    if (s.date > today) continue;
    map.set(s.date, s);
  }

  // collect from views
  for (const v of viewsList) {
    const d = dayFrom(v);
    if (!d) continue;
    if (d > today) continue;
    const entry = map.get(d) || { date: d, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
    entry.views = { count: v.count || 0, uniques: v.uniques || 0 };
    map.set(d, entry);
  }

  // collect from clones
  for (const c of clonesList) {
    const d = dayFrom(c);
    if (!d) continue;
    if (d > today) continue;
    const entry = map.get(d) || { date: d, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
    entry.clones = { count: c.count || 0, uniques: c.uniques || 0 };
    map.set(d, entry);
  }

  // create array of entries, merge with existing snapshots but ensure one entry per date
  const merged = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // write merged back as the canonical list of daily snapshots
  await fs.writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log('Backfilled', merged.length, 'daily entries to', jsonPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
