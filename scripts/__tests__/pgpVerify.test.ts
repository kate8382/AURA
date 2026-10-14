/**
 * Tests for adapter:pgp-verify (issue #88) — real cryptographic verification
 * against the static allow-list in config/trusted-keys/. Covers the three
 * required scenarios: a valid signature, a forged/corrupted signature, and a
 * signature from an untrusted key.
 */
import * as openpgp from 'openpgp';
import fs from 'fs';
import path from 'path';
import { verifySignature } from '../policy/pgpVerify';

// Isolate the allow-list in a tmp-dir — the test must never write to the real
// config/trusted-keys/ (it was mutating the production manifest + leaving keys).
const KEYS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aura-keys-'));
process.env.AURA_TRUSTED_KEYS_DIR = KEYS_DIR;
const SIGNED_TEXT = 'Authorize the release of AURA v2';

// A fresh test-keypair, generated per-run, written into the allow-list.
let trustedFingerprint = '';

async function makeKeyPair(uid: string) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: uid }],
    format: 'armored',
  });
  return { privateKey, publicKey };
}

async function signText(privateKeyArmored: string, text: string) {
  const key = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  const message = await openpgp.createMessage({ text });
  return openpgp.sign({ message, signingKeys: key, detached: true, format: 'armored' }) as Promise<string>;
}

beforeAll(async () => {
  // Ensure the fixture key is in the allow-list for the run.
  const { privateKey, publicKey } = await makeKeyPair('test-signer@aura.example');
  const keyPath = path.join(KEYS_DIR, 'test-signer@aura.example.asc');
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(keyPath, publicKey);
  const pk = await openpgp.readKey({ armoredKey: publicKey });
  trustedFingerprint = pk.getFingerprint();
  const manifest = {
    keys: [
      { key_file: 'test-signer@aura.example.asc', fingerprint: trustedFingerprint, signer_identity: 'test-signer', role: 'tester' },
    ],
  };
  fs.writeFileSync(path.join(KEYS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // stash the private key for signing
  (global as any).__TEST_PRIVKEY = privateKey;
});

describe('adapter:pgp-verify', () => {
  test('valid signature against a trusted key verifies', async () => {
    const sig = await signText((global as any).__TEST_PRIVKEY, SIGNED_TEXT);
    const res = await verifySignature(SIGNED_TEXT, sig);
    expect(res.ok).toBe(true);
    expect(res.verification_status).toBe('verified');
    expect(res.fingerprint).toBe(trustedFingerprint);
    expect(res.signer_identity).toBe('test-signer');
  });

  test('forged/corrupted signature fails closed', async () => {
    const sig = await signText((global as any).__TEST_PRIVKEY, SIGNED_TEXT);
    // Corrupt the armored body (flip a character in the payload region).
    const corrupted = sig.replace('A', 'B');
    const res = await verifySignature(SIGNED_TEXT, corrupted);
    expect(res.ok).toBe(false);
    expect(['bad_signature', 'error']).toContain(res.verification_status);
  });

  test('a different message than the one signed fails closed', async () => {
    const sig = await signText((global as any).__TEST_PRIVKEY, SIGNED_TEXT);
    const res = await verifySignature('A DIFFERENT message entirely', sig);
    // A signature over a different message never verifies — either it fails to
    // verify (bad_signature) or openpgp rejects the mismatched packet (error).
    // Both are fail-closed (ok:false), which is the security contract.
    expect(res.ok).toBe(false);
    expect(['bad_signature', 'error']).toContain(res.verification_status);
  });

  test('signature from an untrusted key is rejected', async () => {
    const { privateKey } = await makeKeyPair('attacker@example.com'); // NOT in the manifest
    const sig = await signText(privateKey, SIGNED_TEXT);
    const res = await verifySignature(SIGNED_TEXT, sig);
    expect(res.ok).toBe(false);
    expect(res.verification_status).toBe('untrusted_key');
  });

  test('empty/missing input fails closed', async () => {
    const res = await verifySignature('', '');
    expect(res.ok).toBe(false);
    expect(res.verification_status).toBe('error');
  });
});
