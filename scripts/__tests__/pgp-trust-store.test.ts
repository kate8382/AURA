import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadTrustStore, resolveTrustStoreDir, TRUST_STORE_DIR_NAME } from '../policy/pgp/trustStore';
import { MAX_MANIFEST_BYTES } from '../policy/pgp/policy';
import { findPathLeaks, sensitiveMarkers } from './helpers/audit-path-scan';
import {
  ed25519Key,
  expiredKey,
  keyFileName,
  makeTempTrustStore,
  manifestEntry,
  rsaKey,
  type TempTrustStore,
} from './helpers/pgp-fixtures';

jest.setTimeout(120_000);

/**
 * Creating a symlink on Windows requires Developer Mode or Administrator
 * privileges, so those tests are skipped there rather than failing for
 * environmental reasons. They still run on Linux / macOS / CI.
 */
const isWindows = process.platform === 'win32';
const symlinkTest = isWindows ? test.skip : test;

describe('resolveTrustStoreDir', () => {
  test('finds the repository trust store from the module location', () => {
    const resolved = resolveTrustStoreDir();
    expect(resolved).not.toBeNull();
    expect(resolved as string).toBe(path.resolve(__dirname, '..', '..', TRUST_STORE_DIR_NAME));
  });

  test('does not consult the process working directory', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(path.parse(originalCwd).root);
      expect(resolveTrustStoreDir()).toBe(path.resolve(__dirname, '..', '..', TRUST_STORE_DIR_NAME));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('returns null when no store is reachable', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pgp-none-'));
    try {
      expect(resolveTrustStoreDir(temp)).toBeNull();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('loadTrustStore', () => {
  let store: TempTrustStore;

  beforeEach(() => {
    store = makeTempTrustStore();
  });

  afterEach(() => {
    store.cleanup();
  });

  test('loads a valid store and normalises the entry', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice, { signer_identity: 'Alice <alice@example.org>' })]);

    const result = await loadTrustStore({ dir: store.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store.entries).toHaveLength(1);
    const entry = result.store.entries[0];
    expect(entry.fingerprint).toBe(alice.fingerprint);
    expect(entry.primaryKeyId).toBe(alice.primaryKeyId);
    expect(entry.keyIds).toEqual(alice.keyIds);
    expect(entry.signerIdentity).toBe('Alice <alice@example.org>');
    expect(entry.publicKey.getFingerprint().toUpperCase()).toBe(alice.fingerprint);
    expect(entry.roles).toEqual(['reviewer']);
  });

  test('an empty manifest loads successfully with zero entries (D-1)', async () => {
    store.writeManifest([]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store.entries).toEqual([]);
  });

  test('reports a missing store directory', async () => {
    const result = await loadTrustStore({ dir: path.join(store.dir, 'does-not-exist') });
    expect(result).toMatchObject({ ok: false, code: 'store_dir_not_found' });
  });

  symlinkTest('rejects a symlinked trust store directory', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice)]);

    const linkPath = `${store.dir}-link`;
    fs.symlinkSync(store.dir, linkPath, 'dir');
    try {
      const result = await loadTrustStore({ dir: linkPath });
      expect(result).toMatchObject({ ok: false, code: 'store_dir_symlink' });
      if (result.ok) return;
      expect(result.detail).toBe('trust store path is a symbolic link');
    } finally {
      fs.unlinkSync(linkPath);
    }
  });

  test('trust-store details never contain absolute local paths', async () => {
    // Delimiter-sensitive single patterns missed quoted and parenthesised paths
    // (the sanitiser used to rewrite the quotes), so every representation is
    // checked: bare, quoted, parenthesised, Windows drive and UNC.
    //
    // The marker set is shared with the audit-sanitisation suite so both files
    // agree on what must never appear (tmpdir, cwd, homedir, realpaths and the
    // random mkdtemp basename).

    const missingDir = await loadTrustStore({ dir: path.join(store.dir, 'does-not-exist') });
    expect(missingDir.ok).toBe(false);
    if (missingDir.ok) return;
    expect(findPathLeaks(missingDir.detail, sensitiveMarkers(store.dir))).toEqual([]);

    const missingManifest = await loadTrustStore({ dir: store.dir });
    expect(missingManifest.ok).toBe(false);
    if (missingManifest.ok) return;
    expect(findPathLeaks(missingManifest.detail, sensitiveMarkers(store.dir))).toEqual([]);

    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    store.writeKey(keyFileName(alice), bob.publicKey);
    store.writeManifest([manifestEntry(alice)]);
    const mismatch = await loadTrustStore({ dir: store.dir });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(findPathLeaks(mismatch.detail, sensitiveMarkers(store.dir))).toEqual([]);
  });

  test('reports a missing manifest', async () => {
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_missing' });
  });

  test('reports invalid manifest JSON', async () => {
    store.writeRawManifest('{ not json');
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid_json' });
  });

  test('reports an oversized manifest', async () => {
    const padding = 'x'.repeat(MAX_MANIFEST_BYTES + 16);
    store.writeRawManifest(JSON.stringify({ version: 1, keys: [], pad: padding }));
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_too_large' });
  });

  test('reports a schema violation as a manifest failure', async () => {
    store.writeRawManifest(JSON.stringify({ version: 1, keys: [{ fingerprint: 'nope' }] }));
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid' });
  });

  test('reports a missing key file', async () => {
    const alice = await ed25519Key('Alice');
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_file_missing' });
  });

  test('reports a key file that is a directory', async () => {
    const alice = await ed25519Key('Alice');
    fs.mkdirSync(path.join(store.dir, keyFileName(alice)));
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_file_not_regular' });
  });

  symlinkTest('rejects a symlinked key file', async () => {
    const alice = await ed25519Key('Alice');
    const target = path.join(store.dir, 'real-key.asc');
    fs.writeFileSync(target, alice.publicKey);
    fs.symlinkSync(target, path.join(store.dir, keyFileName(alice)));
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_file_symlink' });
  });

  test('rejects a key file that is not referenced by the manifest', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeKey('stray-key.asc', bob.publicKey);
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'unreferenced_key_file' });
  });

  test('rejects private key material in the trust store', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.privateKey);
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_not_public' });
  });

  test('rejects an unparsable certificate', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(
      keyFileName(alice),
      '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nbm90LWEta2V5\n-----END PGP PUBLIC KEY BLOCK-----\n'
    );
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_unparseable' });
  });

  test('rejects a certificate whose fingerprint does not match the manifest', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    store.writeKey(keyFileName(alice), bob.publicKey);
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'fingerprint_mismatch' });
  });

  test('rejects a weak RSA certificate (below 3072 bits)', async () => {
    const weak = await rsaKey('Weak', 2048);
    store.writeKey(keyFileName(weak), weak.publicKey);
    store.writeManifest([manifestEntry(weak)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_algorithm_disallowed' });
  });

  test('accepts a 3072-bit RSA certificate', async () => {
    const strong = await rsaKey('Strong', 3072);
    store.writeKey(keyFileName(strong), strong.publicKey);
    store.writeManifest([manifestEntry(strong, { signer_identity: 'Strong <strong@example.org>' })]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result.ok).toBe(true);
  });

  test('accepts an expired certificate at load time and defers the time decision', async () => {
    const expired = await expiredKey('Expired');
    store.writeKey(keyFileName(expired), expired.publicKey);
    store.writeManifest([manifestEntry(expired)]);
    const result = await loadTrustStore({ dir: store.dir });
    // Structural validation passes; expiry is enforced at verification time (D-3).
    expect(result.ok).toBe(true);
  });

  test('rejects a store where one of several entries is invalid', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([
      manifestEntry(alice),
      manifestEntry(bob, { key_file: 'missing-key.asc', signer_identity: 'Bob' }),
    ]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_file_missing' });
  });

  test('the shipped production trust store is valid and empty', async () => {
    const result = await loadTrustStore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store.entries).toEqual([]);
    expect(fs.readdirSync(result.store.dir).filter((name) => name.endsWith('.asc'))).toEqual([]);
  });
});
