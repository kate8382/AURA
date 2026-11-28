/**
 * Unicode-aware, deterministic fuzzy normalization for obfuscated trigger text.
 * All functions are pure and dependency-free.
 */

const SEPARATOR_RUN = /(?<=[\p{L}\p{N}])[\s._\-*·•'"]+(?=[\p{L}\p{N}])/gu;
const LEET_RUN = /[\p{L}\p{N}@$]+/gu;
const REPEATED_LETTER = /(\p{L})\1+/gu;
const UNICODE_WORD_BOUNDARY_SPLIT = /[^\p{L}\p{N}]+/u;

const LEET_MAP: ReadonlyMap<string, string> = new Map([
  ['0', 'o'],
  ['1', 'i'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
  ['@', 'a'],
  ['$', 's'],
]);

const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map([
  // Cyrillic -> Latin
  ['а', 'a'], ['е', 'e'], ['і', 'i'], ['ј', 'j'], ['о', 'o'],
  ['р', 'p'], ['с', 'c'], ['ѕ', 's'], ['у', 'y'], ['х', 'x'],
  ['һ', 'h'], ['ԁ', 'd'], ['ԛ', 'q'], ['ѵ', 'v'], ['ӏ', 'l'],
  // Greek -> Latin
  ['α', 'a'], ['ι', 'i'], ['κ', 'k'], ['ν', 'v'], ['ο', 'o'],
  ['ρ', 'p'], ['χ', 'x'], ['ϲ', 'c'],
  // Other lookalikes (keys are lowercase, because folding runs after lowercasing)
  ['ɡ', 'g'], ['ı', 'i'], ['ℓ', 'l'], ['ɑ', 'a'], ['ꭰ', 'd'], ['ѡ', 'w'],
]);

function collapseSeparators(s: string): string {
  return s.replace(SEPARATOR_RUN, '');
}

function foldConfusables(s: string): string {
  let out = '';
  for (const ch of s) {
    out += CONFUSABLE_MAP.get(ch) ?? ch;
  }
  return out;
}

// Leet digits/symbols are folded only inside runs that contain Latin letters
// and no non-ASCII characters, so Cyrillic/Greek words are left untouched.
function foldLeet(s: string): string {
  return s.replace(LEET_RUN, (run) => {
    const isLatinRun = /[a-z]/.test(run) && !/[^\x00-\x7F]/.test(run);
    if (!isLatinRun) return run;
    let out = '';
    for (const ch of run) {
      out += LEET_MAP.get(ch) ?? ch;
    }
    return out;
  });
}

function collapseRepeats(s: string): string {
  return s.replace(REPEATED_LETTER, '$1');
}

/**
 * fuzzyKey
 * Canonical comparison key for obfuscated text. Steps, in order:
 * NFKC -> lowercase -> collapse separators between letters/digits ->
 * fold confusable glyphs -> fold leet -> collapse repeated letters.
 */
export function fuzzyKey(s: string): string {
  const normalized = s.normalize('NFKC').toLowerCase();
  return collapseRepeats(foldLeet(foldConfusables(collapseSeparators(normalized))));
}

/** Split on any non-letter, non-digit run (Unicode-aware); drops empty tokens. */
export function unicodeTokenize(s: string): string[] {
  return s.split(UNICODE_WORD_BOUNDARY_SPLIT).filter((t) => t.length > 0);
}
