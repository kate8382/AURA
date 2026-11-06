/**
 * Independent filesystem-path detector used by the audit hardening tests.
 *
 * The tests assert on the *final* string that reaches the externally visible
 * `cross_check_audit` record, not on the implementation of the sanitiser, so
 * several independent representations are checked instead of a single pattern:
 * POSIX paths (bare, quoted, parenthesised), Windows drive paths, UNC paths,
 * `file://` URLs, `~/` home paths, mid-string parent-directory traversal, and
 * the residue a partial redaction leaves behind. Exact markers (the temporary
 * store directory, the process working directory, the OS home directory, the
 * OS temp root, the store's random `mkdtemp` basename) are checked as a
 * separate, implementation-free signal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Native `realpath`, captured at module load.
 *
 * Tests install spies on `fs.realpathSync` and `fs.realpathSync.native`, so
 * resolving markers at call time would follow whichever spy is active. The
 * capture here gives the marker set a stable, implementation-free baseline.
 */
const realpathNative: (p: string) => string =
  typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;

/** One detected leak: what kind of path shape was found, and the text that matched. */
export interface PathLeak {
  kind: string;
  match: string;
}

const PATH_LEAK_DETECTORS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // A `/` that starts a token: not preceded by a path-continuation character.
  // `config/trusted-keys` is therefore not reported, `/home/user/x` is.
  { kind: 'posix-absolute', pattern: /(?:^|[^A-Za-z0-9._-])\/[A-Za-z0-9._~-]/ },
  // A Windows drive path. The separator must be a real path separator (`\` or
  // `/`): a `?` here is a sanitised non-path character (a quote, a bracket),
  // so `-A:?` or `time:?` is prose, not a path.
  { kind: 'windows-drive', pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/ },
  { kind: 'unc', pattern: /\\\\[A-Za-z0-9._$-]+\\/ },
  { kind: 'file-url', pattern: /file:\/\//i },
  // Parent-directory traversal at a token boundary.
  { kind: 'traversal', pattern: /(?:^|[^A-Za-z0-9._-])\.\.[\\/]/ },
  // `~/` is a home-directory path that survives a naive character filter
  // until the tilde is replaced; detect it on the raw form.
  { kind: 'home-tilde', pattern: /(?:^|[^A-Za-z0-9._-])~[A-Za-z0-9_-]*\// },
  // A redaction that stopped mid-path leaves path text glued to the marker,
  // e.g. `<path>/Users` or `<path>\home`. Only real path separators (`/` and
  // `\`) are accepted as the boundary: `?` in the output is always a sanitised
  // non-path character (a quote, a bracket, ...), so `<path>?text` is harmless
  // and must not be reported.
  { kind: 'redaction-residue', pattern: /<path>[\\/][A-Za-z0-9]/ },
];

/**
 * Finds every filesystem path shape in a string.
 *
 * @param value text taken from an audit record or a trust-store detail
 * @param markers additional exact strings that must never appear (e.g. the
 *   absolute directory of a temporary trust store)
 */
export function findPathLeaks(value: string, markers: string[] = []): PathLeak[] {
  const leaks: PathLeak[] = [];

  for (const detector of PATH_LEAK_DETECTORS) {
    const match = detector.pattern.exec(value);
    if (match) leaks.push({ kind: detector.kind, match: match[0] });
  }

  for (const marker of markers) {
    if (marker.length > 0 && value.includes(marker)) {
      leaks.push({ kind: 'exact-marker', match: marker });
    }
  }

  return leaks;
}

/** Convenience predicate used by assertions. */
export function containsPathLeak(value: string, markers: string[] = []): boolean {
  return findPathLeaks(value, markers).length > 0;
}

/**
 * Exact strings that must never survive into an audit detail.
 *
 * Covers the temporary store directory, the process working directory, the
 * OS home directory and the OS temp root, plus the realpath of each (macOS
 * resolves `/var/...` to `/private/var/...`, so the raw and real forms
 * differ). The store's random `mkdtemp` basename is included as a final
 * defence: even a partial redaction of the store path leaves that segment
 * behind.
 *
 * `realpathNative` is captured at module load (before any test installs a
 * spy on `fs.realpathSync`), so this set reflects the environment, not the
 * mock active inside the current test.
 */
export function sensitiveMarkers(storeDir?: string): string[] {
  const markers = new Set<string>();
  const add = (value: string): void => {
    // Skip empty strings and the filesystem root: they are either useless as
    // markers or would match unrelated `/` characters in every diagnostic.
    if (value.length > 1) markers.add(value);
  };
  for (const base of [os.tmpdir(), process.cwd(), os.homedir(), storeDir]) {
    if (base === undefined) continue;
    add(base);
    try {
      add(realpathNative(base));
    } catch {
      // realpath is best-effort; the raw value is already recorded above.
    }
  }
  if (storeDir !== undefined) {
    add(path.basename(storeDir));
  }
  return [...markers];
}

/**
 * Self-test: verifies that each detector actually detects what it claims and
 * that the negative cases (relative paths, plain identifiers, numeric
 * timestamps, URL schemes) are not flagged.
 *
 * Call this from `pgp-audit-sanitization.test.ts` so a broken regex fails the
 * suite instead of silently passing every assertion:
 *
 *   import { runDetectorSelfTest } from './helpers/audit-path-scan';
 *   test('detector self-test', () => runDetectorSelfTest());
 */
export function runDetectorSelfTest(): void {
  const positives: Array<{ input: string; kind: string }> = [
    { input: '/home/user/secret', kind: 'posix-absolute' },
    { input: 'C:\\Users\\bob', kind: 'windows-drive' },
    { input: 'C:/Users/bob', kind: 'windows-drive' },
    { input: '\\\\server\\share\\dir', kind: 'unc' },
    { input: 'file:///etc/passwd', kind: 'file-url' },
    { input: '../../etc/passwd', kind: 'traversal' },
    { input: '~/.ssh/id_rsa', kind: 'home-tilde' },
    { input: '<path>/home', kind: 'redaction-residue' },
    { input: '<path>\\Users', kind: 'redaction-residue' },
  ];
  for (const { input, kind } of positives) {
    const leaks = findPathLeaks(input);
    if (!leaks.some((leak) => leak.kind === kind)) {
      throw new Error(
        `self-test: expected kind '${kind}' for ${JSON.stringify(input)}, got ${JSON.stringify(leaks)}`
      );
    }
  }

  const negatives: string[] = [
    'config/trusted-keys',
    'no config/trusted-keys directory found next to this module',
    'key file is missing: signer.asc',
    'manifest is larger than 262144 bytes',
    'unexpected trust-store error (code=ENOENT)',
    'error (<path>)',
    '?<path>?',
    '<path>?Users',
    '<path>?a',
    '-A:?',
    'time:?',
    'C:',
    'a: b',
    'a:b',
    '1:30',
  ];
  for (const input of negatives) {
    const leaks = findPathLeaks(input);
    if (leaks.length > 0) {
      throw new Error(
        `self-test: false positive on ${JSON.stringify(input)}: ${JSON.stringify(leaks)}`
      );
    }
  }
}
