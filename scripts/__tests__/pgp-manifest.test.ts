import { findDuplicateKeyId, validateManifest } from '../policy/pgp/manifest';
import { MAX_MANIFEST_ENTRIES } from '../policy/pgp/policy';

const FINGERPRINT = 'A'.repeat(40);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: FINGERPRINT,
    key_file: 'reviewer.asc',
    signer_identity: 'Reviewer <reviewer@example.org>',
    roles: ['security-reviewer'],
    status: 'active',
    valid_from: '2025-01-01T00:00:00Z',
    valid_to: '2030-01-01T00:00:00Z',
    ...overrides,
  };
}

function manifest(keys: unknown[] = [entry()], extra: Record<string, unknown> = {}): unknown {
  return { version: 1, keys, ...extra };
}

describe('validateManifest', () => {
  test('accepts a valid manifest and normalises the entry', () => {
    const result = validateManifest(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      fingerprint: FINGERPRINT,
      keyFile: 'reviewer.asc',
      signerIdentity: 'Reviewer <reviewer@example.org>',
      roles: ['security-reviewer'],
      status: 'active',
      validFrom: '2025-01-01T00:00:00Z',
      validTo: '2030-01-01T00:00:00Z',
    });
  });

  test('an empty trust store is valid (D-1)', () => {
    const result = validateManifest(manifest([]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
  });

  test('valid_to may be omitted or null', () => {
    const withoutValidTo = entry();
    delete (withoutValidTo as Record<string, unknown>).valid_to;
    expect(validateManifest(manifest([withoutValidTo])).ok).toBe(true);
    expect(validateManifest(manifest([entry({ valid_to: null })])).ok).toBe(true);
  });

  test('roles are optional', () => {
    const withoutRoles = entry();
    delete (withoutRoles as Record<string, unknown>).roles;
    const result = validateManifest(manifest([withoutRoles]));
    expect(result.ok).toBe(true);
  });

  test('rejects a non-object document', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
    expect(validateManifest('manifest').ok).toBe(false);
  });

  test('rejects an unknown top-level field', () => {
    const result = validateManifest(manifest([entry()], { extra: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('unknown top-level field');
  });

  test('rejects an unsupported version', () => {
    expect(validateManifest({ version: 2, keys: [] }).ok).toBe(false);
    expect(validateManifest({ version: '1', keys: [] }).ok).toBe(false);
  });

  test('rejects a missing keys array', () => {
    expect(validateManifest({ version: 1 }).ok).toBe(false);
  });

  test('rejects an unknown entry field', () => {
    const result = validateManifest(manifest([entry({ trust: 'full' })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('unknown field');
  });

  test('rejects a missing required entry field', () => {
    const missing = entry();
    delete (missing as Record<string, unknown>).signer_identity;
    const result = validateManifest(manifest([missing]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('missing required field');
  });

  test('rejects lowercase or malformed fingerprints', () => {
    expect(validateManifest(manifest([entry({ fingerprint: 'a'.repeat(40) })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ fingerprint: 'ABC' })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ fingerprint: `${'A'.repeat(39)} ` })])).ok).toBe(false);
  });

  test('rejects duplicate fingerprints', () => {
    const result = validateManifest(manifest([entry(), entry({ key_file: 'second.asc' })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('duplicate fingerprint');
  });

  test('rejects duplicate key files', () => {
    const second = entry({ fingerprint: 'B'.repeat(40) });
    const result = validateManifest(manifest([entry(), second]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('duplicate key_file');
  });

  test('rejects path traversal and absolute key files', () => {
    for (const keyFile of ['../escape.asc', 'sub/dir.asc', '/etc/passwd.asc', '..', '.hidden.asc', 'key.pgp']) {
      const result = validateManifest(manifest([entry({ key_file: keyFile })]));
      expect(result.ok).toBe(false);
    }
  });

  test('rejects invalid status values', () => {
    expect(validateManifest(manifest([entry({ status: 'trusted' })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ status: 'ACTIVE' })])).ok).toBe(false);
  });

  test('rejects malformed validity timestamps', () => {
    const bad = [
      '2025-01-01',
      '2025-01-01T00:00:00+00:00',
      '2025-01-01T00:00:00.000Z',
      '2025-13-01T00:00:00Z',
      'not-a-date',
      1735689600,
    ];
    for (const validFrom of bad) {
      expect(validateManifest(manifest([entry({ valid_from: validFrom })])).ok).toBe(false);
    }
  });

  test('rejects a validity window that ends before it starts', () => {
    const result = validateManifest(
      manifest([entry({ valid_from: '2030-01-01T00:00:00Z', valid_to: '2025-01-01T00:00:00Z' })])
    );
    expect(result.ok).toBe(false);
  });

  test('rejects malformed signer identities and roles', () => {
    expect(validateManifest(manifest([entry({ signer_identity: '' })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ signer_identity: 'a\nb' })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ roles: 'reviewer' })])).ok).toBe(false);
    expect(validateManifest(manifest([entry({ roles: ['Reviewer'] })])).ok).toBe(false);
  });

  test('rejects a manifest with too many entries', () => {
    const keys = Array.from({ length: MAX_MANIFEST_ENTRIES + 1 }, (_unused, index) =>
      entry({
        fingerprint: index.toString(16).toUpperCase().padStart(40, 'C'),
        key_file: `key-${index}.asc`,
      })
    );
    const result = validateManifest(manifest(keys));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain(String(MAX_MANIFEST_ENTRIES));
  });
});

describe('findDuplicateKeyId', () => {
  test('returns null for unique Key IDs', () => {
    expect(findDuplicateKeyId(['AAAA', 'BBBB'])).toBeNull();
  });

  test('reports a Key ID repeated inside one certificate', () => {
    expect(findDuplicateKeyId(['AAAA', 'BBBB', 'AAAA'])).toBe('AAAA');
  });

  test('is case-insensitive so hex casing cannot smuggle a duplicate', () => {
    expect(findDuplicateKeyId(['aaaa', 'AAAA'])).toBe('AAAA');
  });
});
