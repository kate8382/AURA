import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runCli, logInfo } from '../logger';

export function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function generateSignalHash(mappingPath: string) {
  const content = fs.readFileSync(mappingPath, 'utf8');
  const parsed = JSON.parse(content);
  const canonicalString = canonicalize(parsed);
  const hash = crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
  
  const signals = parsed.signals || {};
  const signalCount = Object.keys(signals).length;

  return { sha256: hash, signalCount };
}

if (require.main === module) {
  runCli(() => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const mappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');
    const metaPath = path.join(repoRoot, 'config', 'signal-catalog-meta.json');

    const { sha256, signalCount } = generateSignalHash(mappingPath);

    let version = "1.0.0";
    if (fs.existsSync(metaPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (existing.version) version = existing.version;
        if (existing.sha256 && existing.sha256 !== sha256) {
          const parts = version.split('.').map(Number);
          parts[2] += 1;
          version = parts.join('.');
        }
      } catch (e) {
        // best-effort: ignore corrupt existing meta
      }
    }

    const out = {
      version,
      sha256,
      updated_at: new Date().toISOString(),
      signal_count: signalCount
    };

    fs.writeFileSync(metaPath, JSON.stringify(out, null, 2), 'utf8');
    logInfo('signal catalog hash generated', { path: metaPath, sha256, signalCount, version });
    return 0;
  });
}
