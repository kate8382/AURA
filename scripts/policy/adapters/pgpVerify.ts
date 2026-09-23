/**
 * PGP Signature Verification Adapter
 *
 * This adapter performs a lightweight PGP signature verification using
 * the `openpgp` library if available.  If the library is not present,
 * the adapter will simply return `ok: false` with a note indicating
 * that verification is unavailable.
 *
 * The adapter expects `value` to be a path to a `.sig` file and
 * `metadata` to contain the path to the corresponding public key
 * and the original file.
 */

import { CrossCheckAdapter, CrossCheckRequirement, CrossCheckResult } from '../crossCheckAdapter';
import * as fs from 'fs';
import * as path from 'path';

const openpgp = tryRequire('openpgp') as typeof import('openpgp') | undefined;

function tryRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return undefined;
  }
}

const pgpAdapter: CrossCheckAdapter = {
  name: 'pgp-verify',
  async check(req: CrossCheckRequirement): Promise<CrossCheckResult> {
    if (!openpgp) {
      return {
        ok: false,
        notes: ['openpgp library not available'],
      };
    }

    const { value, metadata } = req;
    if (!metadata?.publicKeyPath || !metadata?.originalFilePath) {
      return {
        ok: false,
        notes: ['Missing publicKeyPath or originalFilePath in metadata'],
      };
    }

    try {
      const sig = await fs.promises.readFile(value, 'utf8');
      const original = await fs.promises.readFile(metadata.originalFilePath, 'utf8');
      const publicKeyArmored = await fs.promises.readFile(metadata.publicKeyPath, 'utf8');

      const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
      const signature = await openpgp.readSignature({ armoredSignature: sig });

      const verificationResult = await openpgp.verify({
        message: await openpgp.createMessage({ text: original }),
        signature,
        verificationKeys: publicKey,
      });

      const { verified, keyID } = verificationResult.signatures[0];
      try {
        await verified; // throws if not verified
        return {
          ok: true,
          audit: { keyID: keyID?.toHex() },
        };
      } catch (e: any) {
        return {
          ok: false,
          notes: ['PGP signature verification failed', e.message],
        };
      }
    } catch (e: any) {
      return {
        ok: false,
        notes: ['Error during PGP verification', e.message],
      };
    }
  },
};

export default pgpAdapter;
