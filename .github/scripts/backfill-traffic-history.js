#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

function isoDayFrom(v) {
  if (!v && v !== 0) return null;
  if (typeof v === 'string') {
    const s = v.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const parsed = Date.parse(v);
    if (!isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return null;
  }
  if (typeof v === 'number') {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const jsonPath = path.join(repoRoot, 'analytics', 'traffic-history.json');

  let data = [];
  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    data = JSON.parse(raw || '[]');
  } catch (e) {
    // File may not exist yet; nothing to do
    console.warn('Could not read existing traffic history (continuing):', e.message);
    data = [];
  }

  if (!Array.isArray(data)) {
    console.error('Unexpected traffic-history.json format: expected an array');
    process.exit(1);
  }

  // Build a map of date => entry { date, views: {count, uniques}, clones: {count, uniques} }
  const map = new Map();
  const today = new Date().toISOString().slice(0, 10);

  // Helper to merge a single-day record into map
  const mergeRecord = (d, rec) => {
    if (!d) return;
    if (d > today) return; // ignore future-looking days
    const existing = map.get(d) || { date: d, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
    if (rec.views) {
      existing.views = {
        count: typeof rec.views.count === 'number' ? rec.views.count : (existing.views.count || 0),
        uniques: typeof rec.views.uniques === 'number' ? rec.views.uniques : (existing.views.uniques || 0),
      };
    }
    if (rec.clones) {
      existing.clones = {
        count: typeof rec.clones.count === 'number' ? rec.clones.count : (existing.clones.count || 0),
        uniques: typeof rec.clones.uniques === 'number' ? rec.clones.uniques : (existing.clones.uniques || 0),
      };
    }
    map.set(d, existing);
  };

  // Two possible input shapes we want to accept and merge:
  // 1) Flat daily entries: [{ date: 'YYYY-MM-DD', views: {count, uniques}, clones: {count, uniques} }, ...]
  // 2) Snapshots containing per_day arrays: [{ views: { per_day: [...] }, clones: { per_day: [...] } }, ...]

  // First pass: if items already look like flat daily entries, merge them directly
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const d = isoDayFrom(item.date || item.timestamp || item.day);
    const isFlat = !!d && (item.views && (typeof item.views.count === 'number' || typeof item.views.uniques === 'number') || item.clones && (typeof item.clones.count === 'number' || typeof item.clones.uniques === 'number'));
    if (isFlat) {
      mergeRecord(d, {
        views: item.views || undefined,
        clones: item.clones || undefined,
      });
      continue;
    }

    // If item contains per_day arrays, extract them
    if (item.views && Array.isArray(item.views.per_day)) {
      for (const v of item.views.per_day) {
        const dd = isoDayFrom(v.timestamp || v.date || v.day || v[0]);
        if (!dd) continue;
        mergeRecord(dd, { views: { count: v.count || 0, uniques: v.uniques || 0 } });
      }
    }
    if (item.clones && Array.isArray(item.clones.per_day)) {
      for (const c of item.clones.per_day) {
        const dd = isoDayFrom(c.timestamp || c.date || c.day || c[0]);
        if (!dd) continue;
        mergeRecord(dd, { clones: { count: c.count || 0, uniques: c.uniques || 0 } });
      }
    }

    // If item itself is a dated summary (has date and counts), merge as well
    if (item.date && (item.views || item.clones)) {
      const dd = isoDayFrom(item.date);
      mergeRecord(dd, { views: item.views || undefined, clones: item.clones || undefined });
    }
  }

  // If map is still empty, nothing useful found
  if (map.size === 0) {
    console.warn('No daily data extracted from traffic-history.json — leaving file unchanged.');
    process.exit(0);
  }

  // Sort dates ascending
  const merged = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Ensure directory exists and write file
  try {
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf8');
    console.log('Backfilled and merged', merged.length, 'daily entries to', jsonPath);
  } catch (e) {
    console.error('Failed to write', jsonPath, e.message);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
