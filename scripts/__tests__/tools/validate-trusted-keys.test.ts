import fs from 'fs';
import path from 'path';

import * as openpgp from 'openpgp';

import { checkCertificatePolicy, validateTrustedKeys } from '../../tools/validate-trusted-keys';
import {
  ed25519Key,
  expiredKey,
  keyFileName,
  makeTempTrustStore,
  manifestEntry,
  rsaKey,
  shortLivedKey,
  type TempTrustStore,
} from '../helpers/pgp-fixtures';

jest.setTimeout(180_000);

const THREE_YEARS_SECONDS = 3 * 365 * 24 * 60 * 60;

describe('validateTrustedKeys (store level)', () => {
  let store: TempTrustStore;

  beforeEach(() => {
    store = makeTempTrustStore();
  });

  afterEach(() => {
    store.cleanup();
  });

  test('passes for a valid Ed25519 certificate with a one-year validity', async () => {
    const alice = await shortLivedKey('Alice', 365 * 24 * 60 * 60);
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result).toEqual({ ok: true, entriesChecked: 1, violations: [] });
  });

  test('passes for the repository trust store as shipped (empty, D-1)', async () => {
    const result = await validateTrustedKeys();
    expect(result).toMatchObject({ ok: true, entriesChecked: 0, violations: [] });
  });

  test('rejects an expired certificate', async () => {
    const expired = await expiredKey('Expired');
    store.writeKey(keyFileName(expired), expired.publicKey);
    store.writeManifest([manifestEntry(expired)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: keyFileName(expired), code: 'expired' })
    );
  });

  test('rejects a certificate whose validity exceeds two years from creation', async () => {
    const long = await shortLivedKey('LongLived', THREE_YEARS_SECONDS);
    store.writeKey(keyFileName(long), long.publicKey);
    store.writeManifest([manifestEntry(long)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result.violations).toContainEqual(expect.objectContaining({ code: 'validity_window_exceeded' }));
  });

  test('rejects an RSA-2048 certificate (below the 3072-bit minimum)', async () => {
    // openpgp.js refuses to generate RSA keys below 2047 bits, so 2048 is the weakest key we can build.
    const weak = await rsaKey('Weak2048', 2048);
    store.writeKey(keyFileName(weak), weak.publicKey);
    store.writeManifest([manifestEntry(weak)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ code: 'key_algorithm_disallowed' }));
  });

  test('rejects a broken ASCII-armor block', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnot-base64!!\n-----END PGP PUBLIC KEY BLOCK-----\n');
    store.writeManifest([manifestEntry(alice)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, violations: [expect.objectContaining({ code: 'key_unparseable' })] });
  });

  test('rejects a certificate whose fingerprint differs from the manifest', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice, { fingerprint: bob.fingerprint })]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, violations: [expect.objectContaining({ code: 'fingerprint_mismatch' })] });
  });

  test('rejects a key file that is not referenced by the manifest', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, violations: [expect.objectContaining({ code: 'unreferenced_key_file' })] });
  });

  test('rejects a manifest entry whose key file does not exist', async () => {
    const alice = await ed25519Key('Alice');
    store.writeManifest([manifestEntry(alice)]);

    const result = await validateTrustedKeys({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, violations: [expect.objectContaining({ code: 'key_file_missing' })] });
    expect(fs.existsSync(path.join(store.dir, keyFileName(alice)))).toBe(false);
  });
});

describe('checkCertificatePolicy (certificate level)', () => {
  test('rejects a SHA-1 certificate signature', async () => {
    const alice = await ed25519Key('Alice');
    const key = await openpgp.readKey({ armoredKey: alice.publicKey });
    key.users[0].selfCertifications[0].hashAlgorithm = openpgp.enums.hash.sha1;

    const violations = await checkCertificatePolicy(key, new Date());
    expect(violations).toContainEqual(
      expect.objectContaining({ code: 'disallowed_hash_algorithm', subject: 'primary key' })
    );
  });

  test('rejects an MD5 certificate signature', async () => {
    const alice = await ed25519Key('Alice');
    const key = await openpgp.readKey({ armoredKey: alice.publicKey });
    key.users[0].selfCertifications[0].hashAlgorithm = openpgp.enums.hash.md5;

    const violations = await checkCertificatePolicy(key, new Date());
    expect(violations).toContainEqual(
      expect.objectContaining({ code: 'disallowed_hash_algorithm', subject: 'primary key' })
    );
  });

  test('rejects a certificate without an expiration date', async () => {
    const alice = await ed25519Key('Alice');
    const key = await openpgp.readKey({ armoredKey: alice.publicKey });

    const violations = await checkCertificatePolicy(key, new Date());
    expect(violations).toContainEqual(expect.objectContaining({ code: 'no_expiration', subject: 'primary key' }));
  });

  test('rejects an expired encryption subkey while the primary key is still valid', async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'SubExpired', email: 'subexpired@example.org' }],
      date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      keyExpirationTime: 365 * 24 * 60 * 60,
      subkeys: [{ sign: true, keyExpirationTime: 24 * 60 * 60 }],
      format: 'armored',
    });
    const key = await openpgp.readKey({ armoredKey: pair.publicKey });

    const violations = await checkCertificatePolicy(key, new Date());
    const expired = violations.filter((v) => v.code === 'expired');
    expect(expired.length).toBeGreaterThan(0);
    expect(expired.every((v) => v.subject.startsWith('subkey '))).toBe(true);
    expect(violations.some((v) => v.subject === 'primary key' && v.code === 'expired')).toBe(false);
  });

  test('accepts a P-521 certificate with an approved validity window (ECDSA and ECDH)', async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'nistP521',
      userIDs: [{ name: 'P521', email: 'p521@example.org' }],
      date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      keyExpirationTime: 365 * 24 * 60 * 60,
      format: 'armored',
    });
    const key = await openpgp.readKey({ armoredKey: pair.publicKey });

    expect(key.getSubkeys().length).toBeGreaterThan(0);
    expect(await checkCertificatePolicy(key, new Date())).toEqual([]);
  });

  test('accepts a P-256 certificate with an approved validity window', async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'nistP256',
      userIDs: [{ name: 'P256', email: 'p256@example.org' }],
      date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      keyExpirationTime: 365 * 24 * 60 * 60,
      format: 'armored',
    });
    const key = await openpgp.readKey({ armoredKey: pair.publicKey });

    expect(await checkCertificatePolicy(key, new Date())).toEqual([]);
  });
});
