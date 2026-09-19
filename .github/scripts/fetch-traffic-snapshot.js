#!/usr/bin/env node
const fs = require('fs').promises;
const { execSync } = require('child_process');
const path = require('path');

function repoFromGit() {
  try {
    const url = execSync('git config --get remote.origin.url').toString().trim();
    const m = url.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch (e) { }
  return null;
}

async function fetchJson(url, token) {
  const headers = { 'User-Agent': 'aura-traffic-script' };
  if (token) headers.Authorization = `token ${token}`;
  if (typeof fetch !== 'function') {
    // Node 18+ has global fetch; if not, fail with a clear message
    throw new Error('Global fetch is not available in this Node runtime. Use Node 18+ or install a fetch polyfill.');
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${res.statusText}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const jsonPath = path.join(repoRoot, 'analytics', 'traffic-history.json');

  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const r = repoFromGit();
    if (r) ({ owner, repo } = r);
  }
  if (!owner || !repo) {
    console.error('Cannot determine repository owner/name. Set GITHUB_OWNER and GITHUB_REPO env vars or configure git remote.');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

  const viewsUrl = `https://api.github.com/repos/${owner}/${repo}/traffic/views`;
  const clonesUrl = `https://api.github.com/repos/${owner}/${repo}/traffic/clones`;

  try {
    console.log('Fetching traffic for', `${owner}/${repo}`);
    console.log('Token provided:', !!token);
    const viewsData = await fetchJson(viewsUrl, token);
    const clonesData = await fetchJson(clonesUrl, token);

    // Load existing history into a map keyed by date
    let historyMap = new Map();
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      const current = JSON.parse(raw || '[]');
      for (const item of current) {
        if (item && item.date) historyMap.set(item.date, item);
      }
    } catch (e) {
      // file may not exist yet
    }

    // Pull per-day views (last ~14 days) and merge
    const viewsList = viewsData.views || [];
    for (const v of viewsList) {
      const day = String(v.timestamp || v.date || v.day || '').slice(0, 10);
      if (!day) continue;
      const entry = historyMap.get(day) || { date: day, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
      entry.views = { count: v.count || 0, uniques: v.uniques || 0 };
      historyMap.set(day, entry);
    }

    // Pull per-day clones and merge
    const clonesList = clonesData.clones || [];
    for (const c of clonesList) {
      const day = String(c.timestamp || c.date || c.day || '').slice(0, 10);
      if (!day) continue;
      const entry = historyMap.get(day) || { date: day, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
      entry.clones = { count: c.count || 0, uniques: c.uniques || 0 };
      historyMap.set(day, entry);
    }

    // Sort by date ascending
    const sortedHistory = Array.from(historyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(sortedHistory, null, 2), 'utf8');
    console.log(`Successfully updated traffic history. Total days recorded: ${sortedHistory.length}`);
    // Detailed log of recent days fetched for debugging
    const recent = sortedHistory.slice(-10).map(d => ({ date: d.date, views: d.views || {}, clones: d.clones || {} }));
    console.log('Recent entries (up to 10):', JSON.stringify(recent, null, 2));
  } catch (err) {
    if (err && err.status && (err.status === 401 || err.status === 403)) {
      console.error('GitHub API returned', err.status, '— unauthenticated or insufficient permissions.');
      console.error('Ensure TRAFFIC_TOKEN or GITHUB_TOKEN with repo access is available when running this script.');
    } else {
      console.error('Failed to fetch traffic:', err && err.message ? err.message : err);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
