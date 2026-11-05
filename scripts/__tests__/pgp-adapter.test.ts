/**
 * Adapter-level tests: canonical input contract, audit shape, framework
 * integration and the `recalc_confidence` pipeline.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import CrossCheckAdapter, { CrossCheckAdapter as CrossCheckAdapterClass } from '../policy/crossCheckAdapter';
import { loadTriggerConfig } from '../config';
import { RecalcConfidence } from '../recalc_confidence';
import { CANONICAL_INPUT_FIELDS, createPgpVerifyAdapter, pgpVerifyAdapter } from '../policy/pgp/adapter';
import {
  ed25519Key,
  keyFileName,
  makeTempTrustStore,
  manifestEntry,
  signCleartext,
  signDetached,
} from './helpers/pgp-fixtures';

jest.setTimeout(120_000);

const MESSAGE = 'Detached approval text\n';

async function tempStoreWith(keys: Awaited<ReturnType<typeof ed25519Key>>[]) {
  const temp = makeTempTrustStore();
  for (const key of keys) temp.writeKey(keyFileName(key), key.publicKey);
  temp.writeManifest(keys.map((key) => manifestEntry(key)));
  return temp;
}

describe('canonical input contract', () => {
  test('only the four canonical fields are read', () => {
    expect([...CANONICAL_INPUT_FIELDS]).toEqual([
      'signed_message',
      'detached_signature',
      'cleartext_message',
      'expected_signer',
    ]);
  });

  test('rejects an empty requirement', async () => {
    const result = await pgpVerifyAdapter({});
    expect(result.ok).toBe(false);
    expect(result.result.verification_status).toBe('invalid_input');
    expect(result.result.reason).toBe('missing_canonical_fields');
  });

  test('rejects legacy aliases instead of reading them', async () => {
    const alice = await ed25519Key('Alice');
    const signature = await signDetached(alice, MESSAGE);
    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const result = await adapter({
        message: MESSAGE,
        signature,
        signed_message_text: MESSAGE,
        detached_signature_text: signature,
      });
      expect(result.ok).toBe(false);
      expect(result.result.verification_status).toBe('invalid_input');
      expect(result.result.reason).toBe('missing_canonical_fields');
    } finally {
      store.cleanup();
    }
  });

  test('rejects a partial detached field pair', async () => {
    const alice = await ed25519Key('Alice');
    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const result = await adapter({ signed_message: MESSAGE });
      expect(result.result.reason).toBe('missing_canonical_fields');
    } finally {
      store.cleanup();
    }
  });

  test('rejects mixed detached and cleartext inputs', async () => {
    const alice = await ed25519Key('Alice');
    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const result = await adapter({
        cleartext_message: '-----BEGIN PGP SIGNED MESSAGE-----\n',
        signed_message: MESSAGE,
        detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
      });
      expect(result.result.verification_status).toBe('invalid_input');
      expect(result.result.reason).toBe('mixed_input_modes');
    } finally {
      store.cleanup();
    }
  });

  test('rejects non-string canonical fields', async () => {
    const result = await pgpVerifyAdapter({ signed_message: 123, detached_signature: {} });
    expect(result.result.verification_status).toBe('invalid_input');
    expect(result.result.reason).toBe('unexpected_field_type');
  });

  test('rejects empty values', async () => {
    const emptyMessage = await pgpVerifyAdapter({
      signed_message: '',
      detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
    });
    expect(emptyMessage.result.reason).toBe('empty_field');

    const emptySignature = await pgpVerifyAdapter({ signed_message: MESSAGE, detached_signature: '   ' });
    expect(emptySignature.result.reason).toBe('empty_field');
  });

  test('enforces the input size limits', async () => {
    const oversizedMessage = await pgpVerifyAdapter({
      signed_message: 'a'.repeat(256 * 1024 + 1),
      detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
    });
    expect(oversizedMessage.result.verification_status).toBe('input_too_large');
    expect(oversizedMessage.result.reason).toBe('field_too_large');

    const oversizedSignature = await pgpVerifyAdapter({
      signed_message: MESSAGE,
      detached_signature: 'b'.repeat(64 * 1024 + 1),
    });
    expect(oversizedSignature.result.verification_status).toBe('input_too_large');

    const oversizedCleartext = await pgpVerifyAdapter({
      cleartext_message: 'c'.repeat(256 * 1024 + 1),
    });
    expect(oversizedCleartext.result.verification_status).toBe('input_too_large');

    const oversizedExpectedSigner = await pgpVerifyAdapter({
      signed_message: MESSAGE,
      detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
      expected_signer: 'x'.repeat(321),
    });
    expect(oversizedExpectedSigner.result.verification_status).toBe('invalid_input');
    expect(oversizedExpectedSigner.result.reason).toBe('expected_signer_too_long');
  });

  test('never throws on hostile input shapes', async () => {
    for (const requirement of [null, undefined, 42, 'text', [], { signed_message: null }]) {
      const result = await pgpVerifyAdapter(requirement as unknown);
      expect(result.ok).toBe(false);
    }
  });
});

describe('audit record', () => {
  test('contains the required security metadata for a verified signature', async () => {
    const alice = await ed25519Key('Alice');
    const signature = await signDetached(alice, MESSAGE);
    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const result = await adapter({ signed_message: MESSAGE, detached_signature: signature });

      expect(result.ok).toBe(true);
      expect(result.result.verification_status).toBe('verified');
      expect(result.result.fingerprint).toBe(alice.fingerprint);
      expect(result.result.key_id).toBe(alice.primaryKeyId);
      expect(result.result.signer_identity).toBe(`${alice.primaryKeyId} signer`);
      expect(result.result.trusted_signers).toHaveLength(1);
      expect(result.result.trust_store_entries).toBe(1);
      expect(result.result.expected_signer_matched).toBeNull();
      expect(result.result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      store.cleanup();
    }
  });

  test('never contains message text, signature text or attacker-controlled strings', async () => {
    const alice = await ed25519Key('Alice');
    const marker = 'UNIQUE-SIGNED-MARKER-42';
    const message = `${marker}\n`;
    const signature = await signDetached(alice, message);
    const signatureBody = signature
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
      .join('');

    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const ok = await adapter({ signed_message: message, detached_signature: signature });
      const serialised = JSON.stringify(ok.result);
      expect(serialised).not.toContain(marker);
      expect(serialised).not.toContain(signatureBody.slice(0, 40));
      expect(ok.notes).not.toContain(marker);

      const tampered = await adapter({ signed_message: `${marker} changed\n`, detached_signature: signature });
      expect(tampered.ok).toBe(false);
      expect(JSON.stringify(tampered.result)).not.toContain(marker);
      expect(tampered.notes).not.toContain(marker);
    } finally {
      store.cleanup();
    }
  });

  test('cleartext mode also keeps message text out of the audit', async () => {
    const alice = await ed25519Key('Alice');
    const marker = 'CLEARTEXT-MARKER-7';
    const cleartext = await signCleartext(alice, `${marker}\n`);
    const store = await tempStoreWith([alice]);
    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    try {
      const result = await adapter({ cleartext_message: cleartext });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.result)).not.toContain(marker);
      expect(result.result.mode).toBe('cleartext');
    } finally {
      store.cleanup();
    }
  });

  test('reports trust-store problems without leaking raw content', async () => {
    const store = makeTempTrustStore();
    try {
      const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
      const noManifest = await adapter({ signed_message: MESSAGE, detached_signature: '-----BEGIN PGP SIGNATURE-----\n' });
      expect(noManifest.ok).toBe(false);
      expect(noManifest.result.verification_status).toBe('trust_store_error');
      expect(noManifest.result.trust_store_reason).toBe('manifest_missing');

      const missingDir = createPgpVerifyAdapter({ trustStoreDir: path.join(store.dir, 'nope') });
      const missing = await missingDir({ signed_message: MESSAGE, detached_signature: '-----BEGIN PGP SIGNATURE-----\n' });
      expect(missing.result.trust_store_reason).toBe('store_dir_not_found');
      expect(missing.result.reason).toBe('trust_store_unavailable');
    } finally {
      store.cleanup();
    }
  });

  test('a real signature against an empty store fails closed', async () => {
    const outsider = await ed25519Key('Outsider');
    const store = makeTempTrustStore();
    store.writeManifest([]);
    try {
      const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
      const result = await adapter({
        signed_message: MESSAGE,
        detached_signature: await signDetached(outsider, MESSAGE),
      });
      expect(result.ok).toBe(false);
      expect(result.result.verification_status).toBe('no_active_trusted_key');
      expect(result.result.fingerprint).toBeNull();
    } finally {
      store.cleanup();
    }
  });

  test('an empty trust store is not an implementation error but fails closed', async () => {
    const store = makeTempTrustStore();
    store.writeManifest([]);
    try {
      const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
      const result = await adapter({ signed_message: MESSAGE, detached_signature: '-----BEGIN PGP SIGNATURE-----\n' });
      expect(result.ok).toBe(false);
      expect(result.result.verification_status).not.toBe('trust_store_error');
      expect(result.result.trust_store_entries).toBe(0);
    } finally {
      store.cleanup();
    }
  });
});

describe('framework integration', () => {
  test('pgp-verify is registered on the default adapter instance', async () => {
    // A real signature keeps the failure at the trust-store boundary rather
    // than at the armor-parsing boundary.
    const outsider = await ed25519Key('Outsider');
    const requirement = {
      id: 'cc-pgp-signature',
      title: 'Signed authorization letter',
      type: 'boolean',
      signed_message: MESSAGE,
      detached_signature: await signDetached(outsider, MESSAGE),
    };
    const summary = await CrossCheckAdapter.evaluateCrossChecks({}, [requirement as never], {
      'cc-pgp-signature': 'pgp-verify',
    });
    expect(summary.auditEntries).toHaveLength(1);
    expect(summary.auditEntries[0].verifier).toBe('adapter:pgp-verify');
    expect(summary.auditEntries[0].ok).toBe(false);
    // The repository trust store is empty (D-1), so verification fails closed.
    expect((summary.auditEntries[0].result as { verification_status: string }).verification_status).toBe(
      'no_active_trusted_key'
    );
  });

  test('a verification failure never grants evidence weight', async () => {
    const requirement = {
      id: 'cc-pgp-signature',
      title: 'Signed authorization letter',
      type: 'boolean',
      evidence_weight: 0.5,
      signed_message: MESSAGE,
      detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
    };
    const summary = await CrossCheckAdapter.evaluateCrossChecks({}, [requirement as never], {
      'cc-pgp-signature': 'pgp-verify',
    });
    expect(summary.total_weight).toBe(0);
    expect(summary.failed_requirements).toContain('cc-pgp-signature');
  });

  test('config/trigger-weights.json routes the documented requirement to pgp-verify', () => {
    const cfg = loadTriggerConfig();
    expect(cfg.crossCheckAdapters).toBeDefined();
    expect((cfg.crossCheckAdapters as Record<string, string>)['cc-pgp-signature']).toBe('pgp-verify');
  });

  test('existing adapters keep working alongside pgp-verify', async () => {
    const adapter = new CrossCheckAdapterClass();
    const requirements = [
      { id: 'cc-ip', title: 'ip', type: 'boolean', evidence_weight: 0.2 },
      { id: 'cc-pgp', title: 'pgp', type: 'boolean', evidence_weight: 0.3 },
    ];
    const summary = await adapter.evaluateCrossChecks(
      { mock_ip_geo: true },
      requirements as never,
      { 'cc-ip': 'ip-geolocate', 'cc-pgp': 'pgp-verify' }
    );
    expect(summary.auditEntries[0].ok).toBe(true);
    expect(summary.auditEntries[0].verifier).toBe('adapter:ip-geolocate');
    expect(summary.auditEntries[1].ok).toBe(false);
    expect(summary.auditEntries[1].verifier).toBe('adapter:pgp-verify');
  });

  test('recalc_confidence writes the pgp audit entry end to end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pgp-case-'));
    const casePath = path.join(dir, 'case.json');
    const testCase = {
      case_id: 'PGP-1',
      category: 'fraud/example',
      scenarios: [{ name: 's', text: 't', triggers: ['urgency / pressure'] }],
      cross_check: {
        questions: [
          {
            id: 'cc-pgp-signature',
            title: 'Signed authorization letter',
            type: 'boolean',
            evidence_weight: 0.4,
            signed_message: MESSAGE,
            detached_signature: '-----BEGIN PGP SIGNATURE-----\n',
          },
        ],
      },
      confidence: 0.01,
      decision: 'pending',
    };
    try {
      fs.writeFileSync(casePath, JSON.stringify(testCase, null, 2));
      await new RecalcConfidence().recalc(casePath);
      const written = JSON.parse(fs.readFileSync(casePath, 'utf8'));
      expect(Array.isArray(written.cross_check_audit)).toBe(true);
      expect(written.cross_check_audit).toHaveLength(1);
      expect(written.cross_check_audit[0].verifier).toBe('adapter:pgp-verify');
      expect(written.cross_check_audit[0].ok).toBe(false);
      expect(written.cross_check_audit[0].weight_applied).toBe(0);
      expect(written.cross_check_audit[0].result.verification_status).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real verified signature can be routed through the framework', async () => {
    const alice = await ed25519Key('Alice');
    const signature = await signDetached(alice, MESSAGE);
    const store = await tempStoreWith([alice]);
    const adapter = new CrossCheckAdapterClass();
    adapter.registerAdapter('pgp-verify-temp', createPgpVerifyAdapter({ trustStoreDir: store.dir }));
    try {
      const summary = await adapter.evaluateCrossChecks(
        {},
        [
          {
            id: 'cc-pgp-temp',
            title: 'Signed letter',
            type: 'boolean',
            evidence_weight: 0.3,
            signed_message: MESSAGE,
            detached_signature: signature,
          },
        ] as never,
        { 'cc-pgp-temp': 'pgp-verify-temp' }
      );
      expect(summary.auditEntries[0].ok).toBe(true);
      expect(summary.auditEntries[0].weight_applied).toBeCloseTo(0.3, 5);
      expect(summary.total_weight).toBeCloseTo(0.3, 5);
    } finally {
      store.cleanup();
    }
  });
});
