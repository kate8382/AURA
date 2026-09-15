import fs from 'fs/promises';
import path from 'path';

type OldMap = Record<string, string[]>;

function oldToNewKey(old: string): string {
  if (!old || typeof old !== 'string') return old;
  const prefix = 'SIG-';
  if (!old.startsWith(prefix)) return old.toLowerCase();
  const rest = old.slice(prefix.length);
  const parts = rest.split('-').map(p => p.toLowerCase());
  const cat = parts[0];
  const sub = parts.slice(1).join('_') || 'general';
  return `${cat}:${sub}`;
}

function humanDescription(key: string): string {
  // key like "camouflage:naive" -> "Camouflage: naive"
  const [cat, sub] = key.split(':');
  const cap = (s: string) => s.split(/[_\s]+/).map(w => w.charAt(0) + w.slice(1)).join(' ');
  return `${cap(cat)}: ${cap(sub)}`;
}

async function readJson(p: string) {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(p: string, data: any) {
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

async function walkJsonFiles(dir: string): Promise<string[]> {
  const res: string[] = [];
  async function go(d: string) {
    const ents = await fs.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await go(full);
      else if (e.isFile() && e.name.endsWith('.json')) res.push(full);
    }
  }
  await go(dir);
  return res;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const repoRoot = path.resolve(__dirname, '..', '..');
  const mappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');
  const casesDir = path.join(repoRoot, 'public_cases');

  const mapping = await readJson(mappingPath).catch(() => null);
  if (!mapping || !mapping.signals) {
    console.error('Could not read existing mapping at', mappingPath);
    process.exit(1);
  }
  const oldSignals: OldMap = mapping.signals;

  const oldToNew: Record<string, string> = {};
  const newSignals: Record<string, any> = {};

  for (const oldKey of Object.keys(oldSignals)) {
    const newKey = oldToNewKey(oldKey);
    oldToNew[oldKey] = newKey;
    if (!newSignals[newKey]) {
      newSignals[newKey] = {
        id: newKey,
        description: humanDescription(newKey),
        triggers: Array.isArray(oldSignals[oldKey]) ? oldSignals[oldKey] : []
      };
    } else {
      // append triggers
      newSignals[newKey].triggers = Array.from(new Set(newSignals[newKey].triggers.concat(oldSignals[oldKey] || [])));
    }
  }

  console.log('Planned signal keys:', Object.keys(newSignals).length);
  if (!dry) {
    // backup old mapping
    await writeJson(mappingPath + '.bak', mapping);
    const out = { $schema: mapping.$schema || undefined, description: mapping.description || undefined, signals: newSignals };
    await writeJson(mappingPath, out);
    console.log('Wrote new mapping to', mappingPath);
  } else {
    console.log('[dry] Would write new mapping with keys:', Object.keys(newSignals));
  }

  // Now update public_cases signal_ids
  const files = await walkJsonFiles(casesDir);
  let changed = 0;
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, 'utf8');
      const obj = JSON.parse(raw);
      let mutated = false;
      function updateNode(node: any) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const it of node) updateNode(it);
          return;
        }
        if (Array.isArray(node.signal_ids)) {
          const mapped = node.signal_ids.map((s: string) => oldToNew[s] || s);
          // only replace if different
          if (JSON.stringify(mapped) !== JSON.stringify(node.signal_ids)) {
            node.signal_ids = mapped;
            mutated = true;
          }
        }
        for (const k of Object.keys(node)) updateNode(node[k]);
      }
      updateNode(obj);
      if (mutated) {
        changed++;
        if (!dry) {
          await fs.copyFile(f, f + '.bak');
          await writeJson(f, obj);
          console.log('Updated', f);
        } else {
          console.log('[dry] Would update', f);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`Done. Files changed: ${changed}`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
