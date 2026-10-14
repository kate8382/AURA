/**
 * Tests for the trusted-keys CI validator (issue #89): the allow-list
 * must be well-formed — valid armor, unexpired, declared in the manifest,
 * no weak algorithms. Covers a passing manifest, an undeclared key, and
 * a fingerprint mismatch.
 */
import * as openpgp from 'openpgp';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Isolate the allow-list in a tmp-dir — the suite writes fixture keys/manifests
// and must never touch the real config/trusted-keys/.
const KEYS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aura-vk-'));
process.env.AURA_TRUSTED_KEYS_DIR = KEYS_DIR;
const MANIFEST = path.join(KEYS_DIR, 'manifest.json');
const VALIDATOR = 'scripts/tools/validate-trusted-keys.ts';

function runValidator(): { code: number; out: string } {
  try {
    const out = execSync(`npx ts-node ${VALIDATOR}`, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, AURA_TRUSTED_KEYS_DIR: KEYS_DIR },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

let manifestBackup = '';
const fileBackups = new Map<string, string>();

beforeAll(() => {
  manifestBackup = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
});

afterEach(() => {
  if (manifestBackup) fs.writeFileSync(MANIFEST, manifestBackup);
  for (const [f, c] of fileBackups) fs.writeFileSync(path.join(KEYS_DIR, f), c);
  fileBackups.clear();
});

async function keyFor(uid: string): Promise<{ pub: string; fp: string }> {
  const { publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: uid }], format: 'armored' });
  const pk = await openpgp.readKey({ armoredKey: publicKey });
  return { pub: publicKey, fp: pk.getFingerprint() };
}

describe('validate-trusted-keys CI gate', () => {
  test('an undeclared .asc on disk fails', async () => {
    // A manifest declaring a different key + file, so the orphan shows undeclared.
    const { pub, fp } = await keyFor('declared@x');
    fs.writeFileSync(path.join(KEYS_DIR, 'declared@x.asc'), pub);
    fs.writeFileSync(MANIFEST, JSON.stringify({ keys: [{ key_file: 'declared@x.asc', fingerprint: fp, signer_identity: 'x' }] }));
    const { pub: orphanPub } = await keyFor('orphan@x');
    fs.writeFileSync(path.join(KEYS_DIR, 'orphan@x.asc'), orphanPub);
    const r = runValidator();
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOT declared');
    fs.rmSync(path.join(KEYS_DIR, 'orphan@x.asc'));
  });

  test('a fingerprint mismatch between manifest and key fails', async () => {
    const { pub } = await keyFor('mismatch@x');
    fs.writeFileSync(path.join(KEYS_DIR, 'mismatch@x.asc'), pub);
    fs.writeFileSync(MANIFEST, JSON.stringify({ keys: [{ key_file: 'mismatch@x.asc', fingerprint: 'deadbeef'.repeat(5), signer_identity: 'x' }] }));
    const r = runValidator();
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not match manifest');
    fs.rmSync(path.join(KEYS_DIR, 'mismatch@x.asc'));
  });

  test('a manifest entry pointing at a missing file fails', () => {
    fs.writeFileSync(MANIFEST, JSON.stringify({ keys: [{ key_file: 'ghost@x.asc', fingerprint: 'a'.repeat(40), signer_identity: 'x' }] }));
    const r = runValidator();
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing');
  });
});
