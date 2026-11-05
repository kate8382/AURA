/**
 * Test fixtures for the `pgp-verify` adapter.
 *
 * All keypairs are generated at test runtime in memory / temporary
 * directories. No private key material is ever committed, and nothing here
 * touches `config/trusted-keys/` (the production trust store stays empty).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as openpgp from 'openpgp';

export interface GeneratedTestKey {
  publicKey: string;
  privateKey: string;
  revocationCertificate: string;
  fingerprint: string;
  primaryKeyId: string;
  keyIds: string[];
}

const cache = new Map<string, Promise<GeneratedTestKey>>();

function remember(name: string, factory: () => Promise<GeneratedTestKey>): Promise<GeneratedTestKey> {
  const existing = cache.get(name);
  if (existing) return existing;
  const created = factory();
  cache.set(name, created);
  return created;
}

async function describe(pair: { publicKey: string; privateKey: string; revocationCertificate: string }): Promise<GeneratedTestKey> {
  const key = await openpgp.readKey({ armoredKey: pair.publicKey });
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    revocationCertificate: pair.revocationCertificate,
    fingerprint: key.getFingerprint().toUpperCase(),
    primaryKeyId: key.getKeyID().toHex().toUpperCase(),
    keyIds: key.getKeyIDs().map((id) => id.toHex().toUpperCase()),
  };
}

/** Generates (once per worker) a plain Ed25519 signing key. */
export function ed25519Key(name: string): Promise<GeneratedTestKey> {
  return remember(name, async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Generates (once per worker) an RSA key of the requested size. */
export function rsaKey(name: string, bits: number): Promise<GeneratedTestKey> {
  return remember(`${name}-${bits}`, async () => {
    const pair = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: bits,
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Key whose primary key expired one day after creation, a month ago. */
export function expiredKey(name: string): Promise<GeneratedTestKey> {
  return remember(name, async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      keyExpirationTime: 24 * 60 * 60,
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Key with an added signing subkey (valid at the time of generation). */
export function keyWithSigningSubkey(name: string): Promise<GeneratedTestKey> {
  return remember(name, async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      subkeys: [{ sign: true }],
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Key that is valid now but expires after `seconds`. */
export function shortLivedKey(name: string, seconds: number): Promise<GeneratedTestKey> {
  return remember(`${name}-${seconds}`, async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      keyExpirationTime: seconds,
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Key whose signing subkey expires one day after creation (created just now). */
export function keyWithExpiringSigningSubkey(name: string): Promise<GeneratedTestKey> {
  return remember(name, async () => {
    const pair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name, email: `${name.toLowerCase()}@example.org` }],
      subkeys: [{ sign: true, keyExpirationTime: 24 * 60 * 60 }],
      format: 'armored',
    });
    return describe(pair);
  });
}

/** Public certificate of `key`, revoked (the private key is left untouched). */
export async function revokedPublicKey(key: GeneratedTestKey): Promise<string> {
  const publicKey = await openpgp.readKey({ armoredKey: key.publicKey });
  const revoked = await openpgp.revokeKey({
    key: publicKey,
    revocationCertificate: key.revocationCertificate,
    format: 'armored',
  });
  return revoked.publicKey;
}

/** Public certificate of `key` with its signing subkey revoked. */
export async function revokedSubkeyCertificate(key: GeneratedTestKey): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
  const subkey = privateKey.getSubkeys()[0];
  const revokedSubkey = await subkey.revoke(
    privateKey.keyPacket as openpgp.SecretKeyPacket,
    { flag: openpgp.enums.reasonForRevocation.keySuperseded, string: 'test' },
    new Date()
  );
  privateKey.subkeys[0] = revokedSubkey;
  return privateKey.toPublic().armor();
}

/** Public certificate of `key` with the binding signatures of its subkeys stripped. */
export async function certificateWithBrokenSubkeyBinding(key: GeneratedTestKey): Promise<string> {
  const publicKey = await openpgp.readKey({ armoredKey: key.publicKey });
  for (const subkey of publicKey.getSubkeys()) {
    subkey.bindingSignatures = [];
  }
  return publicKey.armor();
}

/** Signs `text` detached with the primary key. */
export async function signDetached(key: GeneratedTestKey, text: string): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
  return openpgp.sign({
    message: await openpgp.createMessage({ text }),
    signingKeys: privateKey,
    detached: true,
  });
}

/** Signs `text` detached with the first signing subkey. */
export async function signDetachedWithSubkey(key: GeneratedTestKey, text: string): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
  const subkey = privateKey.getSubkeys()[0];
  return openpgp.sign({
    message: await openpgp.createMessage({ text }),
    signingKeys: privateKey,
    signingKeyIDs: [subkey.getKeyID()],
    detached: true,
  });
}

/** Signs `text` as a cleartext signed message with the primary key. */
export async function signCleartext(key: GeneratedTestKey, text: string): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
  return openpgp.sign({
    message: await openpgp.createCleartextMessage({ text }),
    signingKeys: privateKey,
  });
}

/** Signs `text` detached with several keys, producing one packet per key. */
export async function signDetachedWithKeys(keys: GeneratedTestKey[], text: string): Promise<string> {
  const privateKeys = await Promise.all(keys.map((key) => openpgp.readPrivateKey({ armoredKey: key.privateKey })));
  return openpgp.sign({
    message: await openpgp.createMessage({ text }),
    signingKeys: privateKeys,
    detached: true,
  });
}

function armorSignature(binary: Uint8Array): string {
  const base64 = Buffer.from(binary).toString('base64');
  const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PGP SIGNATURE-----\n\n${wrapped}\n-----END PGP SIGNATURE-----\n`;
}

/**
 * Returns the binary signature packets and lets the caller rewrite the packet
 * header fields. OpenPGP.js cannot emit SHA-1 or non-document signatures, so
 * this is the only way to exercise those rejection paths with real packets.
 */
function signatureBodyOffset(binary: Uint8Array): number {
  if (binary.length < 6) throw new Error('signature packet too short');
  const first = binary[0];
  if ((first & 0x80) === 0) throw new Error('not an OpenPGP packet header');
  let offset = 1;
  if ((first & 0x40) !== 0) {
    // New-format header: tag in the low six bits, then 1/2/5 length octets.
    if ((first & 0x3f) !== 2) throw new Error('unexpected packet tag');
    const length1 = binary[1];
    if (length1 < 192) offset += 1;
    else if (length1 < 224) offset += 2;
    else if (length1 === 255) offset += 5;
    else throw new Error('partial body lengths are not supported');
  } else {
    // Old-format header: tag in bits 5..2, length type in bits 1..0.
    if (((first >> 2) & 0x0f) !== 2) throw new Error('unexpected packet tag');
    const lengthType = first & 0x03;
    offset += lengthType === 0 ? 1 : lengthType === 1 ? 2 : lengthType === 2 ? 4 : 1;
  }
  if (binary[offset] !== 4) throw new Error('unexpected signature version');
  return offset;
}

/** Rewrites the hash algorithm of every signature packet (e.g. to SHA-1 = 2). */
export async function signatureWithHashAlgorithm(armored: string, hashAlgorithm: number): Promise<string> {
  const signature = await openpgp.readSignature({ armoredSignature: armored });
  const binary = new Uint8Array(await signature.write());
  const offset = signatureBodyOffset(binary);
  const patched = Buffer.from(binary);
  patched[offset + 3] = hashAlgorithm;
  return armorSignature(new Uint8Array(patched));
}

/** Rewrites the signature type of every signature packet (e.g. to standalone = 2). */
export async function signatureWithType(armored: string, signatureType: number): Promise<string> {
  const signature = await openpgp.readSignature({ armoredSignature: armored });
  const binary = new Uint8Array(await signature.write());
  const offset = signatureBodyOffset(binary);
  const patched = Buffer.from(binary);
  patched[offset + 1] = signatureType;
  return armorSignature(new Uint8Array(patched));
}

/** Concatenates several detached signatures into a single armored packet list. */
export async function concatSignatures(armoredSignatures: string[]): Promise<string> {
  const parts: Buffer[] = [];
  for (const armored of armoredSignatures) {
    const signature = await openpgp.readSignature({ armoredSignature: armored });
    parts.push(Buffer.from(await signature.write()));
  }
  return armorSignature(new Uint8Array(Buffer.concat(parts)));
}

/**
 * Rewrites the issuer Key ID inside the (unhashed) signature subpackets.
 *
 * This models an attacker who claims someone else's Key ID: the packet is
 * structurally valid, the issuer field is not covered by the digest.
 */
export async function signatureWithIssuerKeyId(
  armored: string,
  fromKeyIdHex: string,
  toKeyIdHex: string
): Promise<string> {
  const signature = await openpgp.readSignature({ armoredSignature: armored });
  const binary = Buffer.from(await signature.write());
  const from = Buffer.from(fromKeyIdHex, 'hex');
  const to = Buffer.from(toKeyIdHex, 'hex');
  // The unhashed-subpacket copy comes after the hashed one; rewriting the last
  // occurrence keeps the hashed area (and therefore the digest) intact.
  const index = binary.lastIndexOf(from);
  if (index < 0) throw new Error('issuer key id not found in the signature packet');
  to.copy(binary, index);
  return armorSignature(new Uint8Array(binary));
}

/** Flips the last byte of the last signature packet, invalidating only that packet. */
export async function corruptLastSignaturePacket(armored: string): Promise<string> {
  const signature = await openpgp.readSignature({ armoredSignature: armored });
  const binary = Buffer.from(await signature.write());
  binary[binary.length - 3] = binary[binary.length - 3] ^ 0xff;
  return armorSignature(new Uint8Array(binary));
}

export interface TempTrustStore {
  dir: string;
  cleanup(): void;
  writeManifest(entries: unknown[]): void;
  writeRawManifest(text: string): void;
  writeKey(fileName: string, armored: string): void;
}

/** Creates an isolated trust-store directory in the OS temp area. */
export function makeTempTrustStore(): TempTrustStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pgp-store-'));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    writeManifest(entries: unknown[]) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, keys: entries }, null, 2));
    },
    writeRawManifest(text: string) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), text);
    },
    writeKey(fileName: string, armored: string) {
      fs.writeFileSync(path.join(dir, fileName), armored);
    },
  };
}

/** Builds a manifest entry object for a generated key. */
export function manifestEntry(key: GeneratedTestKey, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: key.fingerprint,
    key_file: `${key.primaryKeyId.toLowerCase()}.asc`,
    signer_identity: `${key.primaryKeyId} signer`,
    roles: ['reviewer'],
    status: 'active',
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: null,
    ...overrides,
  };
}

/** Convenience: file name used by `manifestEntry`. */
export function keyFileName(key: GeneratedTestKey): string {
  return `${key.primaryKeyId.toLowerCase()}.asc`;
}

export { openpgp };
