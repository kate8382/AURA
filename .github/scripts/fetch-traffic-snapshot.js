#!/usr/bin/env node
const fs = require('fs').promises;
const { execSync } = require('child_process');
const path = require('path');

function repoFromGit() {
  try {
    const url = execSync('git config --get remote.origin.url').toString().trim();
    const m = url.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch (e) {}
  return null;
}

async function fetchJson(url, token) {
  const headers = { 'User-Agent': 'aura-traffic-script' };
  if (token) headers.Authorization = `token ${token}`;
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
    console.log('Fetching traffic views and clones for', `${owner}/${repo}`, token ? 'with token' : 'without token');
    const views = await fetchJson(viewsUrl, token);
    const clones = await fetchJson(clonesUrl, token);

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = {
      date: today,
      views: { count: views.count || 0, uniques: views.uniques || 0, per_day: views.views || [] },
      clones: { count: clones.count || 0, uniques: clones.uniques || 0, per_day: clones.clones || [] }
    };

    let current = [];
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      current = JSON.parse(raw || '[]');
    } catch (e) {
      // file might not exist
    }

    if (!current.find(s => s.date === snapshot.date)) current.push(snapshot);
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(current, null, 2), 'utf8');
    console.log('Appended snapshot to', jsonPath);
  } catch (err) {
    if (err && err.status && (err.status === 401 || err.status === 403)) {
      console.error('GitHub API returned', err.status, "— unauthenticated or insufficient permissions.");
      console.error('To proceed, create a Personal Access Token (PAT) with `repo` or `public_repo` scope and run:');
      console.error('  GITHUB_TOKEN=ghp_xxx npm run update:traffic');
      console.error('Create a token at: https://github.com/settings/tokens (Your account → Settings → Developer settings → Personal access tokens)');
    } else {
      console.error('Failed to fetch traffic:', err && err.message ? err.message : err);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
