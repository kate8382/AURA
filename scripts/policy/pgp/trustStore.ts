/**
 * Static local trust store for the `pgp-verify` adapter.
 *
 * The trust store is a directory (default `config/trusted-keys/`) containing
 * `manifest.json` and one ASCII-armored public key file per manifest entry.
 * There is no TOFU, no keyserver lookup and no network access of any kind.
 *
 * Fail-closed rules implemented here:
 *  - the manifest schema is strict (unknown/missing fields are errors);
 *  - any single invalid entry invalidates the WHOLE store - nothing is skipped;
 *  - key files must be regular, non-symlink files that stay inside the store
 *    directory (path traversal, symlinks and absolute paths are rejected);
 *  - private keys, unparsable certificates and fingerprint mismatches are
 *    rejected;
 *  - a certificate exposing duplicate Key IDs is rejected, and Key IDs must be
 *    unique across the entire store (they are the only key identifier the
 *    verification result exposes);
 *  - a valid, empty store loads successfully with zero entries (D-1).
 */
import fs from 'fs';
import path from 'path';
import * as openpgp from 'openpgp';

import { sanitizeDetail, validateManifest, findDuplicateKeyId, type ManifestEntry } from './manifest';
import { MAX_KEY_FILE_BYTES, MAX_MANIFEST_BYTES, PGP_STRICT_CONFIG, checkKeyAlgorithmPolicy } from './policy';
import type { TrustStoreErrorCode } from './types';

/** Directory name used inside the repository for the trust store. */
export const TRUST_STORE_DIR_NAME = path.join('config', 'trusted-keys');
/** File name of the trust-store manifest. */
export const TRUST_STORE_MANIFEST_NAME = 'manifest.json';

/** A fully validated trust-store entry. */
export interface TrustStoreEntry extends ManifestEntry {
  /** Primary-key Key ID, uppercase hex. */
  primaryKeyId: string;
  /** All Key IDs exposed by this certificate (primary + subkeys), uppercase hex. */
  keyIds: string[];
  /** Parsed public certificate. */
  publicKey: openpgp.Key;
}

/** A loaded trust store. */
export interface TrustStore {
  /** Absolute path of the store directory. */
  dir: string;
  entries: TrustStoreEntry[];
  /** Timestamp of the load, ISO-8601 UTC. */
  loadedAt: string;
}

/** Load outcome: either a usable store or a fail-closed diagnostic. */
export type TrustStoreLoadResult =
  | { ok: true; store: TrustStore }
  | { ok: false; code: TrustStoreErrorCode; detail: string };

/**
 * Resolves the repository trust-store directory from the module location.
 *
 * The lookup walks up from the module's own directory (never from
 * `process.cwd()`, so trust decisions cannot be redirected by the caller's
 * working directory) until it finds a directory containing
 * `config/trusted-keys/`. That works both for the `ts-node`/`ts-jest` source
 * layout and for a compiled `dist/scripts/...` layout.
 *
 * @param startDir directory to start from (defaults to this module's directory)
 * @returns absolute store path, or `null` when no store directory is reachable
 */
export function resolveTrustStoreDir(startDir: string = __dirname): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, TRUST_STORE_DIR_NAME);
    // `throwIfNoEntry: false` keeps the "no store at this level" case out of an
    // exception path entirely: most ancestors legitimately have no store.
    const stats = fs.statSync(candidate, { throwIfNoEntry: false });
    if (stats !== undefined && stats.isDirectory()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function fail(code: TrustStoreErrorCode, detail: string): TrustStoreLoadResult {
  return { ok: false, code, detail: sanitizeDetail(detail) };
}

/**
 * Reads a file inside the store directory with symlink and traversal guards.
 *
 * @param dir real path of the store directory
 * @param fileName manifest-provided single-segment file name
 * @param maxBytes hard size limit
 */
function readStoreFile(
  dir: string,
  fileName: string,
  maxBytes: number
): { ok: true; text: string } | { ok: false; code: TrustStoreErrorCode; detail: string } {
  if (fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    return { ok: false, code: 'key_file_escapes_store', detail: `invalid file name: ${fileName}` };
  }

  const target = path.resolve(dir, fileName);
  if (path.dirname(target) !== path.resolve(dir)) {
    return { ok: false, code: 'key_file_escapes_store', detail: `path escapes the trust store: ${fileName}` };
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    // A missing file is an invalid trust-store entry and must fail the store.
    return { ok: false, code: 'key_file_missing', detail: `key file is missing: ${fileName}` };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, code: 'key_file_symlink', detail: `key file is a symbolic link: ${fileName}` };
  }
  if (!stats.isFile()) {
    return { ok: false, code: 'key_file_not_regular', detail: `key file is not a regular file: ${fileName}` };
  }
  if (stats.size > maxBytes) {
    return { ok: false, code: 'key_file_too_large', detail: `key file is larger than ${maxBytes} bytes: ${fileName}` };
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch {
    // O_NOFOLLOW surfaces a symlink as ELOOP; either way the store fails closed.
    return { ok: false, code: 'key_file_unreadable', detail: `key file cannot be opened safely: ${fileName}` };
  }

  try {
    const fdStats = fs.fstatSync(fd);
    if (!fdStats.isFile()) {
      return { ok: false, code: 'key_file_not_regular', detail: `key file is not a regular file: ${fileName}` };
    }
    if (fdStats.size > maxBytes) {
      return {
        ok: false,
        code: 'key_file_too_large',
        detail: `key file is larger than ${maxBytes} bytes: ${fileName}`,
      };
    }
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      // Resolution failure means containment cannot be proven; fail closed.
      return { ok: false, code: 'key_file_unreadable', detail: `key file cannot be resolved: ${fileName}` };
    }
    if (realTarget !== path.join(dir, fileName) && path.dirname(realTarget) !== dir) {
      return { ok: false, code: 'key_file_escapes_store', detail: `key file resolves outside the store: ${fileName}` };
    }
    return { ok: true, text: fs.readFileSync(fd, 'utf8') };
  } catch {
    // Read failures (permissions, I/O) are not recoverable for a trust store.
    return { ok: false, code: 'key_file_unreadable', detail: `key file cannot be read: ${fileName}` };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Validates an armored public key file against its manifest fingerprint.
 *
 * @returns the parsed certificate and its uppercase Key IDs
 */
async function parsePublicKey(
  armored: string,
  fileName: string,
  expectedFingerprint: string
): Promise<{ ok: true; key: openpgp.Key; keyIds: string[] } | { ok: false; code: TrustStoreErrorCode; detail: string }> {
  if (/PRIVATE KEY|SECRET KEY/i.test(armored)) {
    return { ok: false, code: 'key_not_public', detail: `key file contains private key material: ${fileName}` };
  }
  if (!armored.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    return { ok: false, code: 'key_unparseable', detail: `key file is not an ASCII-armored public key: ${fileName}` };
  }

  let key: openpgp.Key;
  try {
    // The strict configuration rejects v6 keys, weak RSA keys and unsupported
    // packets while parsing, so a permissive parse can never leak through here.
    key = await openpgp.readKey({ armoredKey: armored, config: PGP_STRICT_CONFIG });
  } catch {
    // Any parse failure means the stored certificate is unusable.
    return { ok: false, code: 'key_unparseable', detail: `key file cannot be parsed as an OpenPGP certificate: ${fileName}` };
  }

  if (typeof key.isPrivate === 'function' && key.isPrivate()) {
    return { ok: false, code: 'key_not_public', detail: `key file contains a private key: ${fileName}` };
  }

  const fingerprint = String(key.getFingerprint()).toUpperCase();
  if (fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      code: 'fingerprint_mismatch',
      detail: `manifest fingerprint ${expectedFingerprint} does not match certificate ${fingerprint}`,
    };
  }

  // The primary key is the trust anchor, so its algorithm must satisfy the
  // application allow-list at load time. Subkeys are evaluated per signature.
  const algorithmViolation = checkKeyAlgorithmPolicy(key);
  if (algorithmViolation !== null) {
    return {
      ok: false,
      code: 'key_algorithm_disallowed',
      detail: `certificate uses a disallowed key algorithm (${algorithmViolation}): ${fileName}`,
    };
  }

  const keyIds = key
    .getKeyIDs()
    .map((id) => id.toHex().toUpperCase())
    .filter((id) => id.length > 0);
  if (keyIds.length === 0) {
    return { ok: false, code: 'key_unparseable', detail: `certificate exposes no Key IDs: ${fileName}` };
  }
  const duplicate = findDuplicateKeyId(keyIds);
  if (duplicate !== null) {
    return { ok: false, code: 'duplicate_key_id', detail: `certificate reuses Key ID ${duplicate}: ${fileName}` };
  }

  return { ok: true, key, keyIds };
}

/**
 * Loads and validates the trust store.
 *
 * @param options.dir explicit store directory (tests); when omitted the
 *   module-relative repository store is resolved
 */
export async function loadTrustStore(options: { dir?: string } = {}): Promise<TrustStoreLoadResult> {
  try {
    const dir = options.dir ? path.resolve(options.dir) : resolveTrustStoreDir();
    if (dir === null) {
      return fail('store_dir_not_found', `no ${TRUST_STORE_DIR_NAME} directory found next to this module`);
    }

    let dirStats: fs.Stats;
    try {
      // `lstat` (not `stat`) so a symlinked store directory is visible instead
      // of being silently followed.
      dirStats = fs.lstatSync(dir);
    } catch {
      // A configured but missing directory is a trust failure, never a default.
      return fail('store_dir_not_found', 'trust store directory does not exist');
    }
    if (dirStats.isSymbolicLink()) {
      return fail('store_dir_symlink', 'trust store path is a symbolic link');
    }
    if (!dirStats.isDirectory()) return fail('store_dir_not_found', 'trust store path is not a directory');

    const realDir = fs.realpathSync(dir);
    const manifestPath = path.join(realDir, TRUST_STORE_MANIFEST_NAME);

    const manifestNoFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let manifestFd: number;
    try {
      // O_NOFOLLOW makes a symlinked manifest an open error instead of a read.
      manifestFd = fs.openSync(manifestPath, fs.constants.O_RDONLY | manifestNoFollow);
    } catch {
      // Without a manifest there is no defined trust set; fail closed.
      return fail('manifest_missing', 'trust store manifest is missing or cannot be opened safely');
    }

    let manifestText: string;
    try {
      const manifestStats = fs.fstatSync(manifestFd);
      if (!manifestStats.isFile()) return fail('manifest_missing', 'trust store manifest must be a regular file');
      if (manifestStats.size > MAX_MANIFEST_BYTES) {
        return fail('manifest_too_large', `manifest is larger than ${MAX_MANIFEST_BYTES} bytes`);
      }
      manifestText = fs.readFileSync(manifestFd, 'utf8');
    } catch {
      // Unreadable manifest: the store cannot be evaluated.
      return fail('manifest_unreadable', 'trust store manifest cannot be read');
    } finally {
      fs.closeSync(manifestFd);
    }

    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifestText);
    } catch {
      // Invalid JSON is a hard trust-store failure, not an empty store.
      return fail('manifest_invalid_json', 'trust store manifest is not valid JSON');
    }

    const validation = validateManifest(parsedManifest);
    if (!validation.ok) return fail('manifest_invalid', validation.detail);

    const entries: TrustStoreEntry[] = [];
    const storeKeyIds = new Map<string, string>();

    for (const manifestEntry of validation.entries) {
      const file = readStoreFile(realDir, manifestEntry.keyFile, MAX_KEY_FILE_BYTES);
      if (!file.ok) return fail(file.code, file.detail);

      const parsedKey = await parsePublicKey(file.text, manifestEntry.keyFile, manifestEntry.fingerprint);
      if (!parsedKey.ok) return fail(parsedKey.code, parsedKey.detail);

      for (const keyId of parsedKey.keyIds) {
        const owner = storeKeyIds.get(keyId);
        if (owner !== undefined) {
          return fail(
            'duplicate_key_id',
            `Key ID ${keyId} is exposed by both ${owner} and ${manifestEntry.keyFile}`
          );
        }
        storeKeyIds.set(keyId, manifestEntry.keyFile);
      }

      entries.push({
        ...manifestEntry,
        primaryKeyId: parsedKey.key.getKeyID().toHex().toUpperCase(),
        keyIds: parsedKey.keyIds,
        publicKey: parsedKey.key,
      });
    }

    const referenced = new Set(validation.entries.map((entry) => entry.keyFile));
    let directoryEntries: fs.Dirent[];
    try {
      directoryEntries = fs.readdirSync(realDir, { withFileTypes: true });
    } catch {
      // An unreadable store directory makes "no extra keys" unprovable.
      return fail('store_dir_unreadable', 'trust store directory cannot be listed');
    }
    for (const dirent of directoryEntries) {
      if (!dirent.name.toLowerCase().endsWith('.asc')) continue;
      if (!referenced.has(dirent.name)) {
        return fail('unreferenced_key_file', `key file is not referenced by the manifest: ${dirent.name}`);
      }
    }

    return {
      ok: true,
      store: { dir: realDir, entries, loadedAt: new Date().toISOString() },
    };
  } catch (err) {
    // Defensive: any unexpected throw still ends in a fail-closed result.
    return fail('unexpected_error', err instanceof Error ? err.message : String(err));
  }
}
