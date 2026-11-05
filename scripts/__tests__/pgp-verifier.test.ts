/**
 * Real cryptographic tests for the `pgp-verify` core.
 *
 * Every keypair is generated at test runtime inside an isolated temporary
 * trust store; nothing is mocked, and `config/trusted-keys/` is never touched.
 * RSA 3072 key generation is intentionally slow, hence the raised timeout.
 */
import {
  certificateWithBrokenSubkeyBinding,
  concatSignatures,
  corruptLastSignaturePacket,
  ed25519Key,
  keyFileName,
  keyWithExpiringSigningSubkey,
  keyWithSigningSubkey,
  makeTempTrustStore,
  manifestEntry,
  revokedPublicKey,
  revokedSubkeyCertificate,
  rsaKey,
  shortLivedKey,
  signCleartext,
  signDetached,
  signDetachedWithKeys,
  signDetachedWithSubkey,
  signatureWithHashAlgorithm,
  signatureWithIssuerKeyId,
  signatureWithType,
  type GeneratedTestKey,
} from './helpers/pgp-fixtures';
import { loadTrustStore, type TrustStore } from '../policy/pgp/trustStore';
import { representativeSigner, verifyPgpSignature } from '../policy/pgp/verify';

jest.setTimeout(180_000);

const MESSAGE = 'Authorization letter body\n';

async function buildStore(keys: GeneratedTestKey[], overrides: Record<string, unknown> = {}): Promise<TrustStore> {
  const temp = makeTempTrustStore();
  for (const key of keys) {
    temp.writeKey(keyFileName(key), key.publicKey);
  }
  temp.writeManifest(keys.map((key) => manifestEntry(key, overrides)));
  const loaded = await loadTrustStore({ dir: temp.dir });
  if (!loaded.ok) throw new Error(`test store did not load: ${loaded.code} ${loaded.detail}`);
  return loaded.store;
}

async function buildStoreFromCertificates(
  entries: Array<{ key: GeneratedTestKey; certificate: string; overrides?: Record<string, unknown> }>
): Promise<TrustStore> {
  const temp = makeTempTrustStore();
  for (const entry of entries) {
    temp.writeKey(keyFileName(entry.key), entry.certificate);
  }
  temp.writeManifest(entries.map((entry) => manifestEntry(entry.key, entry.overrides)));
  const loaded = await loadTrustStore({ dir: temp.dir });
  if (!loaded.ok) throw new Error(`test store did not load: ${loaded.code} ${loaded.detail}`);
  return loaded.store;
}

describe('detached signatures', () => {
  test('verifies a valid detached signature and anchors on the manifest fingerprint', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('verified');
    expect(outcome.reason).toBe('ok');
    expect(outcome.signatureCount).toBe(1);
    expect(outcome.signers).toHaveLength(1);
    expect(outcome.signers[0].fingerprint).toBe(alice.fingerprint);
    expect(outcome.signers[0].key_id).toBe(alice.primaryKeyId);
    expect(outcome.signers[0].signing_key_fingerprint).toBeNull();
    expect(representativeSigner(outcome.signers)?.fingerprint).toBe(alice.fingerprint);
  });

  test('rejects a modified signed message', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: 'Authorization letter body!\n', detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('invalid_signature');
    expect(outcome.reason).toBe('signature_digest_mismatch');
  });

  test('rejects a signer that is not in the trust store', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice]);
    const signature = await signDetached(bob, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
    expect(outcome.reason).toBe('issuer_not_in_store');
  });

  test('an empty trust store fails closed', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([]);
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('no_active_trusted_key');
    expect(outcome.trustStoreEntries).toBe(0);
  });

  test('rejects malformed signature armor', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);

    const notArmored = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: 'garbage' },
      store,
      new Date()
    );
    expect(notArmored.status).toBe('malformed_signature');
    expect(notArmored.reason).toBe('signature_not_armored');

    const brokenArmor = await verifyPgpSignature(
      {
        mode: 'detached',
        signedMessage: MESSAGE,
        detachedSignature: '-----BEGIN PGP SIGNATURE-----\n\nnot-base64!!\n-----END PGP SIGNATURE-----\n',
      },
      store,
      new Date()
    );
    expect(brokenArmor.status).toBe('malformed_signature');
    expect(brokenArmor.reason).toBe('signature_unparseable');
  });
});

describe('cleartext signatures', () => {
  test('verifies a valid cleartext signed message', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const cleartext = await signCleartext(alice, 'Cleartext approval\n');

    const outcome = await verifyPgpSignature({ mode: 'cleartext', cleartextMessage: cleartext }, store, new Date());

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('verified');
    expect(outcome.mode).toBe('cleartext');
    expect(outcome.signers[0].fingerprint).toBe(alice.fingerprint);
  });

  test('rejects a modified cleartext message', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const cleartext = await signCleartext(alice, 'Cleartext approval granted\n');
    const tampered = cleartext.replace('granted', 'refused');

    const outcome = await verifyPgpSignature({ mode: 'cleartext', cleartextMessage: tampered }, store, new Date());

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('invalid_signature');
  });

  test('rejects cleartext signed by an untrusted signer', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice]);
    const cleartext = await signCleartext(bob, 'Bob approval\n');

    const outcome = await verifyPgpSignature({ mode: 'cleartext', cleartextMessage: cleartext }, store, new Date());

    expect(outcome.status).toBe('untrusted_signer');
  });

  test('rejects unparsable cleartext input', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);

    const outcome = await verifyPgpSignature(
      { mode: 'cleartext', cleartextMessage: '-----BEGIN PGP SIGNED MESSAGE-----\n\nbroken' },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('malformed_signature');
  });
});

describe('expected_signer', () => {
  test('accepts a matching expected_signer', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice], { signer_identity: 'Alice <alice@example.org>' });
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      {
        mode: 'detached',
        signedMessage: MESSAGE,
        detachedSignature: signature,
        expectedSigner: 'Alice <alice@example.org>',
      },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(true);
  });

  test('rejects a mismatching expected_signer', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice], { signer_identity: 'Alice <alice@example.org>' });
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      {
        mode: 'detached',
        signedMessage: MESSAGE,
        detachedSignature: signature,
        expectedSigner: 'Mallory <mallory@example.org>',
      },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('expected_signer_mismatch');
  });
});

describe('key lifecycle at the current verification time', () => {
  test('rejects a signature from an expired primary key', async () => {
    const short = await shortLivedKey('Short', 60 * 60 * 24);
    const store = await buildStore([short]);
    const signature = await signDetached(short, MESSAGE);

    const validNow = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );
    expect(validNow.ok).toBe(true);

    const laterOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    );
    expect(laterOutcome.ok).toBe(false);
    expect(laterOutcome.status).toBe('untrusted_signer');
    expect(laterOutcome.reason).toBe('signer_key_expired');
  });

  test('rejects a revoked primary key even though the signature predates revocation', async () => {
    const alice = await ed25519Key('Alice');
    const signature = await signDetached(alice, MESSAGE);
    const store = await buildStoreFromCertificates([
      { key: alice, certificate: await revokedPublicKey(alice) },
    ]);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
    expect(outcome.reason).toBe('signer_key_revoked');
  });

  test('ignores a disabled manifest entry', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice], { status: 'disabled' });
    const signature = await signDetached(alice, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('signer_disabled');
  });

  test('enforces the manifest validity window', async () => {
    const alice = await ed25519Key('Alice');
    const signature = await signDetached(alice, MESSAGE);

    const expiredWindow = await buildStore([alice], {
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: '2021-01-01T00:00:00Z',
    });
    const expiredOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      expiredWindow,
      new Date()
    );
    expect(expiredOutcome.ok).toBe(false);
    expect(expiredOutcome.reason).toBe('signer_outside_manifest_window');

    const futureWindow = await buildStore([alice], {
      valid_from: '2090-01-01T00:00:00Z',
      valid_to: null,
    });
    const futureOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      futureWindow,
      new Date()
    );
    expect(futureOutcome.ok).toBe(false);
    expect(futureOutcome.reason).toBe('signer_outside_manifest_window');
  });
});

describe('signing subkeys', () => {
  test('records the signing-subkey fingerprint while anchoring on the primary key', async () => {
    const grace = await keyWithSigningSubkey('Grace');
    const store = await buildStore([grace]);
    const signature = await signDetachedWithSubkey(grace, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.signers[0].fingerprint).toBe(grace.fingerprint);
    expect(outcome.signers[0].signing_key_fingerprint).not.toBeNull();
    expect(outcome.signers[0].signing_key_fingerprint).not.toBe(grace.fingerprint);
    expect(outcome.signers[0].key_id).not.toBe(grace.primaryKeyId);
  });

  test('rejects a signature from an expired signing subkey', async () => {
    const heidi = await keyWithExpiringSigningSubkey('Heidi');
    const store = await buildStore([heidi]);
    const signature = await signDetachedWithSubkey(heidi, MESSAGE);

    const nowOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );
    expect(nowOutcome.ok).toBe(true);

    const laterOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    );
    expect(laterOutcome.ok).toBe(false);
    expect(laterOutcome.status).toBe('untrusted_signer');
    expect(laterOutcome.reason).toBe('signer_subkey_expired');
  });

  test('rejects a signature from a revoked signing subkey', async () => {
    const ivan = await keyWithSigningSubkey('Ivan');
    const signature = await signDetachedWithSubkey(ivan, MESSAGE);
    const store = await buildStoreFromCertificates([
      { key: ivan, certificate: await revokedSubkeyCertificate(ivan) },
    ]);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
    expect(outcome.reason).toBe('signer_subkey_revoked');
  });

  test('rejects a signature from a subkey with an invalid binding signature', async () => {
    const judy = await keyWithSigningSubkey('Judy');
    const signature = await signDetachedWithSubkey(judy, MESSAGE);
    const store = await buildStoreFromCertificates([
      { key: judy, certificate: await certificateWithBrokenSubkeyBinding(judy) },
    ]);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
    expect(outcome.reason).toBe('signer_subkey_binding_invalid');
  });
});

describe('algorithm policy', () => {
  test('verifies a 3072-bit RSA signature', async () => {
    const strong = await rsaKey('Strong', 3072);
    const store = await buildStore([strong]);
    const signature = await signDetached(strong, MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.signers[0].fingerprint).toBe(strong.fingerprint);
  });

  test('rejects a SHA-1 signature packet', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const signature = await signDetached(alice, MESSAGE);
    const sha1 = await signatureWithHashAlgorithm(signature, 2);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: sha1 },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('disallowed_algorithm');
    expect(outcome.reason).toBe('disallowed_hash_algorithm');
  });

  test('rejects a non-document signature packet type', async () => {
    const alice = await ed25519Key('Alice');
    const store = await buildStore([alice]);
    const signature = await signDetached(alice, MESSAGE);
    const standalone = await signatureWithType(signature, 2);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: standalone },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('unsupported_signature_type');
    expect(outcome.reason).toBe('unsupported_signature_type');
  });
});

describe('issuer claims are never trusted', () => {
  test('a signature claiming a trusted Key ID does not become trusted', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice]);

    const bobSignature = await signDetached(bob, MESSAGE);
    const forged = await signatureWithIssuerKeyId(bobSignature, bob.primaryKeyId, alice.primaryKeyId);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: forged },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('invalid_signature');
    expect(outcome.reason).toBe('signature_digest_mismatch');
    // The claimed identity is never echoed into the audit as if it were trusted.
    expect(outcome.signers).toEqual([]);
  });
});

describe('multiple signatures', () => {
  test('a trusted signer plus an untrusted co-signature fails closed', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice]);
    const signature = await signDetachedWithKeys([alice, bob], MESSAGE);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
  });

  test('two trusted signers verify and produce deterministic output in any order', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice, bob]);

    const forward = await signDetachedWithKeys([alice, bob], MESSAGE);
    const reversed = await concatSignatures([
      await signDetached(bob, MESSAGE),
      await signDetached(alice, MESSAGE),
    ]);

    const forwardOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: forward },
      store,
      new Date()
    );
    const reversedOutcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: reversed },
      store,
      new Date()
    );

    expect(forwardOutcome.ok).toBe(true);
    expect(reversedOutcome.ok).toBe(true);
    expect(forwardOutcome.signatureCount).toBe(2);
    expect(reversedOutcome.signatureCount).toBe(2);

    const expectedRepresentative =
      alice.fingerprint < bob.fingerprint ? alice.fingerprint : bob.fingerprint;
    expect(representativeSigner(forwardOutcome.signers)?.fingerprint).toBe(expectedRepresentative);
    expect(representativeSigner(reversedOutcome.signers)?.fingerprint).toBe(expectedRepresentative);
    expect(forwardOutcome.signers.map((signer) => signer.fingerprint).sort()).toEqual(
      reversedOutcome.signers.map((signer) => signer.fingerprint).sort()
    );
  });

  test('rejects the whole verification when one co-signature is invalid', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice, bob]);

    const combined = await concatSignatures([await signDetached(alice, MESSAGE), await signDetached(bob, MESSAGE)]);
    const corrupted = await corruptLastSignaturePacket(combined);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: corrupted },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('invalid_signature');
  });

  test('never accepts the first valid signature when a later one is untrusted', async () => {
    const alice = await ed25519Key('Alice');
    const bob = await ed25519Key('Bob');
    const store = await buildStore([alice]);

    // Bob's packet first: a "first valid signature wins" implementation would
    // still pass on Alice's packet, and an order-dependent one would differ.
    const signature = await concatSignatures([
      await signDetached(bob, MESSAGE),
      await signDetached(alice, MESSAGE),
    ]);

    const outcome = await verifyPgpSignature(
      { mode: 'detached', signedMessage: MESSAGE, detachedSignature: signature },
      store,
      new Date()
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('untrusted_signer');
  });
});
