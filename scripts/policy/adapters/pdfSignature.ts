/**
 * PDF Digital Signature Verification Adapter
 *
 * This adapter checks for the presence of an Adobe Digital Signature
 * in a PDF file.  A full verification would require a heavy PDF
 * parsing library (e.g., `pdf-lib` or `pdfjs-dist`).  To keep the
 * dependency footprint minimal, this implementation performs a
 * very lightweight check: it looks for the string "Adobe Signatures"
 * in the PDF binary.  If the `pdf-lib` package is available, a
 * more thorough check is performed.
 */

import { CrossCheckAdapter, CrossCheckRequirement, CrossCheckResult } from '../crossCheckAdapter';
import * as fs from 'fs';
import * as path from 'path';

const pdfLib = tryRequire('pdf-lib') as typeof import('pdf-lib') | undefined;

function tryRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return undefined;
  }
}

const pdfSignatureAdapter: CrossCheckAdapter = {
  name: 'pdf-signature',
  async check(req: CrossCheckRequirement): Promise<CrossCheckResult> {
    const { value } = req;
    try {
      const buffer = await fs.promises.readFile(value);
      const text = buffer.toString('utf8');

      // Quick heuristic: look for Adobe signature marker
      if (!text.includes('Adobe Signatures')) {
        return {
          ok: false,
          notes: ['No Adobe signature section found in PDF'],
        };
      }

      // If pdf-lib is available, attempt a more detailed check
      if (pdfLib) {
        try {
          const pdfDoc = await pdfLib.PDFDocument.load(buffer);
          const signatures = pdfDoc.getSignatureFields();
          if (signatures.length === 0) {
            return {
              ok: false,
              notes: ['pdf-lib found no signature fields'],
            };
          }
          return {
            ok: true,
            audit: { signatures: signatures.map((s) => s.getName()) },
          };
        } catch (e: any) {
          return {
            ok: false,
            notes: ['pdf-lib parsing error', e.message],
          };
        }
      }

      // Fallback: assume signature present if marker found
      return {
        ok: true,
        audit: { marker: 'Adobe Signatures' },
      };
    } catch (e: any) {
      return {
        ok: false,
        notes: ['Error reading PDF file', e.message],
      };
    }
  },
};

export default pdfSignatureAdapter;
