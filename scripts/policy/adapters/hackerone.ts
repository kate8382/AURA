/**
 * HackerOne Public Program Validation Adapter
 *
 * This adapter validates a HackerOne program identifier or URL against
 * the public HackerOne API.  For the purposes of this repository we
 * keep the implementation lightweight and optional: if the `node-fetch`
 * package is available it will perform a real HTTP request; otherwise
 * it falls back to a simple regex check that ensures the ID looks
 * plausible.
 *
 * The adapter returns `ok: true` if the program is found and active,
 * otherwise `ok: false` with a note.
 */

import { CrossCheckAdapter, CrossCheckRequirement, CrossCheckResult } from '../crossCheckAdapter';

const fetch = tryRequire('node-fetch') as typeof import('node-fetch') | undefined;

function tryRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return undefined;
  }
}

const HACKERONE_API = 'https://api.hackerone.com/v1/programs';

const hackeroneAdapter: CrossCheckAdapter = {
  name: 'hackerone',
  async check(req: CrossCheckRequirement): Promise<CrossCheckResult> {
    const { value } = req;
    // Accept either a numeric ID or a URL containing the ID
    const idMatch = value.match(/(?:programs\/)?(\d+)/);
    if (!idMatch) {
      return {
        ok: false,
        notes: ['Invalid HackerOne program identifier'],
      };
    }
    const programId = idMatch[1];

    // If we have fetch, perform a real API call
    if (fetch) {
      try {
        const res = await fetch(`${HACKERONE_API}/${programId}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          return {
            ok: false,
            notes: [`HackerOne API returned ${res.status}`],
          };
        }
        const data = await res.json();
        const active = data?.data?.attributes?.status === 'active';
        return {
          ok: active,
          notes: active
            ? ['Program is active']
            : ['Program is inactive or not public'],
        };
      } catch (e: any) {
        return {
          ok: false,
          notes: ['Error contacting HackerOne API', e.message],
        };
      }
    }

    // Fallback: simple regex to check format
    const isValid = /^\d+$/.test(programId);
    return {
      ok: isValid,
      notes: isValid
        ? ['Program ID format looks valid (no API check performed)']
        : ['Program ID format invalid'],
    };
  },
};

export default hackeroneAdapter;
