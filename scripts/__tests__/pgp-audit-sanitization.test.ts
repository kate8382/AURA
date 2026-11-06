/**
 * Security regression tests for the PGP trust-store audit surface.
 *
 * Two classes of defect are covered here:
 *
 *  1. `sanitizeDetail()` used to be a pure character filter that explicitly
 *     *allowed* `/`, `:` and `\`, so absolute POSIX, Windows drive and UNC paths
 *     survived verbatim in `cross_check_audit[].trust_store_detail`.
 *  2. The `unexpected_error` branch copied `err.message` (raw exception text)
 *     into the audit record; Node.js filesystem errors embed the absolute path
 *     of the file they failed on.
 *
 * The assertions below run against the *final* strings that reach the audit
 * record, using several independent path detectors (see
 * `helpers/audit-path-scan.ts`) plus exact markers for the temporary store,
 * the process working directory and the OS temp root. They also prove that the
 * useful, non-sensitive part of each diagnostic is still reported and that the
 * store keeps failing closed.
 */
import fs from 'fs';
import path from 'path';

import { createPgpVerifyAdapter } from '../policy/pgp/adapter';
import { REDACTED_PATH, isSafeDetailToken, sanitizeDetail } from '../policy/pgp/manifest';
import { loadTrustStore } from '../policy/pgp/trustStore';
import {
  ed25519Key,
  keyFileName,
  makeTempTrustStore,
  manifestEntry,
  type TempTrustStore,
} from './helpers/pgp-fixtures';
import { containsPathLeak, findPathLeaks, sensitiveMarkers } from './helpers/audit-path-scan';

jest.setTimeout(120_000);

/**
 * Platform / privilege guards.
 *
 *  - symlinks require Developer Mode or Administrator privileges on Windows;
 *  - `chmod 000` is a no-op when the test runs as root (typical in Docker);
 *  - a POSIX filename may contain `\` and `:`, a Windows filename may not.
 */
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const symlinkTest = isWindows ? test.skip : test;
const permissionTest = isWindows || isRoot ? test.skip : test;
const posixFilenameTest = isWindows ? test.skip : test;

/** Asserts that a trust-store detail is leak-free and non-empty. */
function expectNoPathLeak(detail: unknown, storeDir?: string): string {
  expect(typeof detail).toBe('string');
  const value = detail as string;
  expect(value.length).toBeGreaterThan(0);
  expect(findPathLeaks(value, sensitiveMarkers(storeDir))).toEqual([]);
  return value;
}

describe('sanitizeDetail redacts every path representation', () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: 'bare POSIX absolute path', input: '/home/user/secret', expected: REDACTED_PATH },
    { label: 'public POSIX path', input: '/tmp/aura/keys/alice.asc', expected: REDACTED_PATH },
    {
      label: 'Node.js ENOENT message',
      input: "ENOENT: no such file or directory, open '/home/a/.ssh/id_rsa'",
      expected: 'ENOENT: no such file or directory, open ?<path>?',
    },
    { label: 'double-quoted path', input: 'failed to read "/tmp/x/y"', expected: 'failed to read ?<path>?' },
    { label: 'single-quoted path', input: "failed to read '/tmp/x/y'", expected: 'failed to read ?<path>?' },
    { label: 'parenthesised path', input: 'error (/var/log/private)', expected: 'error (<path>)' },
    { label: 'path after a colon', input: 'path: /etc/passwd', expected: 'path: <path>' },
    { label: 'Windows backslash path', input: 'C:\\Users\\bob\\AppData\\Local', expected: REDACTED_PATH },
    { label: 'Windows forward-slash path', input: 'C:/Users/bob', expected: REDACTED_PATH },
    { label: 'UNC path', input: '\\\\server\\share\\dir\\file', expected: REDACTED_PATH },
    { label: 'file URL', input: 'file:///etc/passwd', expected: 'file:<path>' },
    { label: 'parent traversal', input: '../../etc/passwd', expected: REDACTED_PATH },
    { label: 'root-relative separators', input: '//////', expected: REDACTED_PATH },
    {
      label: 'several paths in one string',
      input: 'see /home/x, then (/tmp/y) and "C:\\z"',
      expected: 'see <path>, then (<path>) and ?<path>?',
    },
  ];

  test.each(cases)('$label', ({ input, expected }) => {
    expect(sanitizeDetail(input)).toBe(expected);
  });

  test('keeps useful, non-sensitive diagnostics intact', () => {
    const preserved = [
      'no config/trusted-keys directory found next to this module',
      'key file is missing: signer.asc',
      'manifest is larger than 262144 bytes',
      'entry 0: unknown field: status_code',
      'unexpected trust-store error (code=ENOENT)',
    ];
    for (const value of preserved) {
      expect(sanitizeDetail(value)).toBe(value);
      expect(containsPathLeak(sanitizeDetail(value))).toBe(false);
    }
  });

  test('neutralises control characters and quotes', () => {
    const sanitized = sanitizeDetail('line1\nline2\u0000"quoted"\ttab');
    expect(sanitized).not.toMatch(/[\u0000-\u001f]/);
    expect(sanitized).not.toContain('"');
    expect(sanitized.startsWith('line1 line2')).toBe(true);
  });

  test('bounds the output length', () => {
    const sanitized = sanitizeDetail('x'.repeat(500));
    expect(sanitized.length).toBe(163);
    expect(sanitized.endsWith('...')).toBe(true);
  });

  test('is idempotent, so double sanitisation cannot reintroduce a path', () => {
    const inputs = cases.map((entry) => entry.input).concat(['?<path>?', 'no path here']);
    for (const input of inputs) {
      const once = sanitizeDetail(input);
      expect(sanitizeDetail(once)).toBe(once);
      expect(containsPathLeak(sanitizeDetail(once))).toBe(false);
    }
  });

  test('handles non-string input without leaking', () => {
    expect(sanitizeDetail(42)).toBe('42');
    expect(sanitizeDetail(null)).toBe('null');
    expect(sanitizeDetail(undefined)).toBe('undefined');
    expect(sanitizeDetail({ toString: () => '/home/leak' })).toBe(REDACTED_PATH);
  });

  test('handles objects whose toString throws without escaping fail-closed', () => {
    const hostile = Object.create(null) as { toString?: () => string };
    // `Object.create(null)` has no `toString`, so `String(value)` throws.
    expect(() => sanitizeDetail(hostile)).not.toThrow();
    expect(sanitizeDetail(hostile).length).toBeGreaterThan(0);
    expect(containsPathLeak(sanitizeDetail(hostile))).toBe(false);
  });
});

describe('sanitizeDetail handles adversarial inputs', () => {
  // Cases where the exact output is ugly but the invariant "no leak, idempotent"
  // must hold. This is asserted structurally rather than by string equality.
  const adversarial: Array<{ label: string; input: string }> = [
    { label: 'asterisk before a Windows drive path', input: '*C:\\Users\\bob' },
    { label: 'percent before a Windows drive path', input: '%C:\\Users\\bob' },
    { label: 'leading backslash', input: '\\Users\\bob\\x' },
    { label: 'Windows extended-length prefix', input: '\\\\?\\C:\\Users\\x' },
    { label: 'tilde home path', input: '~/.ssh/id_rsa' },
    { label: 'mid-token traversal', input: 'a/../../etc/passwd' },
    { label: 'trailing component traversal', input: 'foo/../secret' },
    { label: 'traversal in a relative config path', input: 'config/../../etc/passwd' },
    { label: 'equals prefix traversal', input: 'x=../secret' },
    { label: 'mixed separators', input: 'a\\..\\..\\etc/passwd' },
  ];

  test.each(adversarial)('$label is leak-free and idempotent', ({ input }) => {
    const once = sanitizeDetail(input);
    const twice = sanitizeDetail(once);
    expect(twice).toBe(once);
    expect(findPathLeaks(once)).toEqual([]);
  });
});

describe('sanitizeDetail fuzz', () => {
  /**
   * Deterministic PRNG-based fuzz test: no dependency, reproducible counter-
   * examples. Verifies that every generated string is (a) leak-free and
   * (b) idempotent. If a counter-example appears, both the input and the
   * intermediate output are included in the failure message.
   */
  function* fuzzInputs(seed: number, count: number): Generator<string> {
    let state = seed >>> 0;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const chars = 'abcABC012/\\:.-_ ?*~%[]{}()<>\'"`;,+|';
    for (let i = 0; i < count; i += 1) {
      const len = (next() % 40) + 1;
      let s = '';
      for (let j = 0; j < len; j += 1) {
        s += chars[next() % chars.length];
      }
      yield s;
    }
  }

  test('1,000 seeded random inputs are idempotent and leak-free', () => {
    let count = 0;
    for (const input of fuzzInputs(0xdeadbeef, 1000)) {
      const once = sanitizeDetail(input);
      const twice = sanitizeDetail(once);
      if (twice !== once) {
        throw new Error(
          `not idempotent for ${JSON.stringify(input)}: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`
        );
      }
      const leaks = findPathLeaks(once);
      if (leaks.length > 0) {
        throw new Error(
          `leak for ${JSON.stringify(input)}: ${JSON.stringify(once)} -> ${JSON.stringify(leaks)}`
        );
      }
      count += 1;
    }
    expect(count).toBe(1000);
  });
});

describe('isSafeDetailToken', () => {
  test('accepts plain identifiers', () => {
    expect(isSafeDetailToken('signer.asc')).toBe(true);
    expect(isSafeDetailToken('ABCDEF0123456789')).toBe(true);
  });

  test('rejects anything that could carry a path or markup', () => {
    for (const value of ['/etc/passwd', 'C:\\evil.asc', 'a/b', '..', '', 'x'.repeat(200), 'a b']) {
      expect(isSafeDetailToken(value)).toBe(false);
    }
    expect(isSafeDetailToken(undefined)).toBe(false);
  });
});

describe('trust-store failure branches never leak a path', () => {
  let store: TempTrustStore;
  let spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    store = makeTempTrustStore();
    spies = [];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    store.cleanup();
  });

  /** Installs a throwing `fs` override and remembers it for restoration. */
  function throwFrom(method: 'realpathSync' | 'readdirSync', thrown: unknown): void {
    const spy = jest.spyOn(fs, method as never).mockImplementation((() => {
      throw thrown;
    }) as never);
    spies.push(spy);
  }

  test('missing store directory', async () => {
    const result = await loadTrustStore({ dir: path.join(store.dir, 'does-not-exist') });
    expect(result).toMatchObject({ ok: false, code: 'store_dir_not_found' });
    if (result.ok) return;
    expectNoPathLeak(result.detail, store.dir);
  });

  test('store path that is a file', async () => {
    const filePath = path.join(store.dir, 'manifest.json');
    store.writeManifest([]);
    const result = await loadTrustStore({ dir: filePath });
    expect(result).toMatchObject({ ok: false, code: 'store_dir_not_found' });
    if (result.ok) return;
    expect(expectNoPathLeak(result.detail)).toBe('trust store path is not a directory');
  });

  test('unresolvable store uses a platform-independent literal', async () => {
    // Force `resolveTrustStoreDir` to walk past every ancestor: `statSync`
    // returns `undefined` for every candidate directory. The resulting detail
    // must be a POSIX-form literal with no local information.
    const statSpy = jest.spyOn(fs, 'statSync' as never).mockImplementation((() => {
      return undefined;
    }) as never);
    try {
      const result = await loadTrustStore();
      expect(result).toMatchObject({ ok: false, code: 'store_dir_not_found' });
      if (result.ok) return;
      expect(result.detail).toBe('no config/trusted-keys directory found next to this module');
    } finally {
      statSpy.mockRestore();
    }
  });

  symlinkTest('symlinked store directory keeps its existing code and detail', async () => {
    const linkPath = `${store.dir}-link`;
    fs.symlinkSync(store.dir, linkPath, 'dir');
    try {
      const result = await loadTrustStore({ dir: linkPath });
      expect(result).toMatchObject({ ok: false, code: 'store_dir_symlink' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail)).toBe('trust store path is a symbolic link');
    } finally {
      fs.unlinkSync(linkPath);
    }
  });

  test('missing manifest', async () => {
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_missing' });
    if (result.ok) return;
    expectNoPathLeak(result.detail, store.dir);
  });

  test('invalid manifest JSON', async () => {
    store.writeRawManifest('{ not json');
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid_json' });
    if (result.ok) return;
    expectNoPathLeak(result.detail, store.dir);
  });

  test('oversized manifest', async () => {
    store.writeRawManifest(`{"version":1,"keys":[],"pad":"${'x'.repeat(300_000)}"}`);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_too_large' });
    if (result.ok) return;
    expect(expectNoPathLeak(result.detail)).toContain('bytes');
  });

  test('manifest with an absolute-path field name is redacted', async () => {
    store.writeRawManifest(JSON.stringify({ version: 1, keys: [], '/home/user/.ssh/id_rsa': 1 }));
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid' });
    if (result.ok) return;
    expect(expectNoPathLeak(result.detail, store.dir)).toBe('unknown top-level field: <field>');
  });

  test('manifest entry with a Windows-path field name is redacted', async () => {
    store.writeRawManifest(
      JSON.stringify({
        version: 1,
        keys: [{ fingerprint: 'A'.repeat(40), key_file: 'a.asc', 'C:\\Users\\bob': 1 }],
      })
    );
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid' });
    if (result.ok) return;
    expect(expectNoPathLeak(result.detail, store.dir)).toBe('entry 0: unknown field: <field>');
  });

  test('manifest with a quoted path in a field name is redacted', async () => {
    store.writeRawManifest(
      JSON.stringify({ version: 1, keys: [], "see '/tmp/private/key.asc'": true })
    );
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'manifest_invalid' });
    if (result.ok) return;
    // The field name is not a plain identifier, so it collapses to a placeholder.
    expect(expectNoPathLeak(result.detail, store.dir)).toBe('unknown top-level field: <field>');
  });

  test('missing key file still names the (safe) file', async () => {
    const alice = await ed25519Key('Alice');
    store.writeManifest([manifestEntry(alice)]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'key_file_missing' });
    if (result.ok) return;
    const detail = expectNoPathLeak(result.detail, store.dir);
    expect(detail).toContain(keyFileName(alice));
  });

  posixFilenameTest('unreferenced .asc file with a path-like name is not echoed', async () => {
    store.writeManifest([]);
    // POSIX allows `\` and `:` inside a file name, so this entry name renders as
    // a Windows absolute path if it is copied verbatim.
    store.writeKey('C:\\Users\\bob\\secret.asc', 'x');
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'unreferenced_key_file' });
    if (result.ok) return;
    const detail = expectNoPathLeak(result.detail, store.dir);
    expect(detail).toBe('key file is not referenced by the manifest: an unrecognised .asc file');
  });

  test('unreferenced .asc file with a safe name keeps its diagnostic value', async () => {
    store.writeManifest([]);
    store.writeKey('extra-signer.asc', 'x');
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'unreferenced_key_file' });
    if (result.ok) return;
    const detail = expectNoPathLeak(result.detail, store.dir);
    expect(detail).toBe('key file is not referenced by the manifest: extra-signer.asc');
  });

  test('fingerprint mismatch reports fingerprints, not paths', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice, { fingerprint: 'B'.repeat(40) })]);
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'fingerprint_mismatch' });
    if (result.ok) return;
    const detail = expectNoPathLeak(result.detail, store.dir);
    expect(detail).toContain('B'.repeat(40));
    expect(detail).toContain(alice.fingerprint);
  });

  permissionTest('unreadable key file reports only the file name', async () => {
    const alice = await ed25519Key('Alice');
    store.writeKey(keyFileName(alice), alice.publicKey);
    store.writeManifest([manifestEntry(alice)]);
    const keyPath = path.join(store.dir, keyFileName(alice));
    fs.chmodSync(keyPath, 0o000);
    try {
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'key_file_unreadable' });
      if (result.ok) return;
      const detail = expectNoPathLeak(result.detail, store.dir);
      expect(detail).toContain(keyFileName(alice));
    } finally {
      fs.chmodSync(keyPath, 0o600);
    }
  });

  test('directory listing failure reports a fixed description', async () => {
    store.writeManifest([]);
    throwFrom('readdirSync', Object.assign(new Error("EACCES: permission denied, scandir '/tmp/aura'"), {
      code: 'EACCES',
    }));
    const result = await loadTrustStore({ dir: store.dir });
    expect(result).toMatchObject({ ok: false, code: 'store_dir_unreadable' });
    if (result.ok) return;
    expect(expectNoPathLeak(result.detail, store.dir)).toBe('trust store directory cannot be listed');
  });

  describe('unexpected exceptions never propagate raw text', () => {
    test('Node.js filesystem error with an absolute path', async () => {
      throwFrom(
        'realpathSync',
        Object.assign(new Error("ENOENT: no such file or directory, realpath '/home/user/.secrets/trusted-keys'"), {
          code: 'ENOENT',
        })
      );
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail, store.dir)).toBe('unexpected trust-store error (code=ENOENT)');
      expect(result.detail).not.toContain('realpath');
    });

    test('Windows path in the exception message', async () => {
      throwFrom('realpathSync', new Error('EACCES: read C:\\Users\\bob\\AppData\\Roaming\\keys.asc'));
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail, store.dir)).toBe('unexpected trust-store error');
    });

    test('thrown non-Error object with a hostile code', async () => {
      throwFrom('realpathSync', { code: '/home/user/.secrets', message: 'boom /tmp/x' });
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail, store.dir)).toBe('unexpected trust-store error');
    });

    test('thrown string', async () => {
      throwFrom('realpathSync', 'failed at /home/user/trust-store');
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail, store.dir)).toBe('unexpected trust-store error');
    });

    test('thrown object whose `code` getter throws', async () => {
      // A throwing getter (or a Proxy with a throwing `get` trap) used to make
      // `describeUnexpectedError` itself throw, defeating fail-closed handling.
      throwFrom(
        'realpathSync',
        Object.defineProperty({}, 'code', {
          get(): never {
            throw new Error('boom');
          },
        })
      );
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(result.detail).toBe('unexpected trust-store error');
    });

    test.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['boolean', false],
    ])('thrown primitive (%s) fails closed with a fixed detail', async (_label, thrown) => {
      throwFrom('realpathSync', thrown);
      const result = await loadTrustStore({ dir: store.dir });
      expect(result).toMatchObject({ ok: false, code: 'unexpected_error' });
      if (result.ok) return;
      expect(expectNoPathLeak(result.detail, store.dir)).toBe('unexpected trust-store error');
    });
  });
});

describe('externally visible audit records are leak-free', () => {
  const requirement = {
    signed_message: 'approve release 1.2.3\n',
    detached_signature: '-----BEGIN PGP SIGNATURE-----\n\nplaceholder\n-----END PGP SIGNATURE-----\n',
  };

  let store: TempTrustStore;
  let spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    store = makeTempTrustStore();
    spies = [];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    store.cleanup();
  });

  test('unexpected exception surfaces a fixed detail and fails closed', async () => {
    spies.push(
      jest.spyOn(fs, 'realpathSync' as never).mockImplementation((() => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/home/user/.ssh/id_rsa'"), {
          code: 'ENOENT',
        });
      }) as never)
    );

    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    const outcome = await adapter(requirement);

    expect(outcome.ok).toBe(false);
    expect(outcome.result.verification_status).toBe('trust_store_error');
    expect(outcome.result.trust_store_reason).toBe('unexpected_error');
    expect(outcome.result.trust_store_detail).toBe('unexpected trust-store error (code=ENOENT)');

    const serialized = JSON.stringify(outcome.result);
    expect(findPathLeaks(serialized, sensitiveMarkers(store.dir))).toEqual([]);
    expect(containsPathLeak(outcome.notes, sensitiveMarkers(store.dir))).toBe(false);
    expect(outcome.result.verification_status).not.toBe('verified');
  });

  posixFilenameTest('hostile unreferenced file name never reaches the audit record', async () => {
    store.writeManifest([]);
    store.writeKey('C:\\Users\\bob\\AppData\\secret.asc', 'x');

    const adapter = createPgpVerifyAdapter({ trustStoreDir: store.dir });
    const outcome = await adapter(requirement);

    expect(outcome.ok).toBe(false);
    expect(outcome.result.verification_status).toBe('trust_store_error');
    expect(outcome.result.trust_store_reason).toBe('unreferenced_key_file');
    expect(findPathLeaks(JSON.stringify(outcome.result), sensitiveMarkers(store.dir))).toEqual([]);
  });

  test('every failing store keeps the verification fail-closed and leak-free', async () => {
    type Scenario = { label: string; prepare: () => Promise<void> | void };
    const scenarios: Scenario[] = [
      { label: 'missing manifest', prepare: () => undefined },
      { label: 'invalid json', prepare: () => store.writeRawManifest('{ nope') },
      {
        label: 'unknown top-level field',
        prepare: () => store.writeRawManifest(JSON.stringify({ version: 1, keys: [], '/tmp/p': 1 })),
      },
      {
        label: 'missing key file',
        prepare: async () => {
          const alice = await ed25519Key('Alice');
          store.writeManifest([manifestEntry(alice)]);
        },
      },
    ];
    if (!isWindows) {
      // POSIX allows `\` and `:` in a filename; Windows does not.
      scenarios.push({
        label: 'unreferenced hostile file',
        prepare: () => {
          store.writeRawManifest(JSON.stringify({ version: 1, keys: [] }));
          store.writeKey('C:\\Users\\bob\\x.asc', 'x');
        },
      });
    }

    for (const scenario of scenarios) {
      const scenarioStore = makeTempTrustStore();
      const previous = store;
      store = scenarioStore;
      try {
        await scenario.prepare();
        const adapter = createPgpVerifyAdapter({ trustStoreDir: scenarioStore.dir });
        const outcome = await adapter(requirement);

        expect(outcome.ok).toBe(false);
        expect(outcome.result.verification_status).toBe('trust_store_error');
        expect(outcome.result.trust_store_detail).not.toBeNull();
        expectNoPathLeak(outcome.result.trust_store_detail, scenarioStore.dir);
        expect(findPathLeaks(JSON.stringify(outcome.result), sensitiveMarkers(scenarioStore.dir))).toEqual([]);
      } finally {
        store = previous;
        scenarioStore.cleanup();
      }
    }
  });
});
