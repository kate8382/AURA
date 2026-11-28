import { fuzzyKey, unicodeTokenize } from '../../core/fuzzy-normalize';

describe('fuzzyKey: separators, leet and repeats', () => {
  test('Latin separators, leet and repeated letters collapse to one key', () => {
    expect(fuzzyKey('b.o.m.b.a')).toBe('bomba');
    expect(fuzzyKey('v.z.r.y.v')).toBe('vzryv');
    expect(fuzzyKey('b0mba')).toBe('bomba');
    expect(fuzzyKey('bbbomb')).toBe('bomb');
  });

  test('Cyrillic separator-obfuscated forms match the plain word', () => {
    expect(fuzzyKey('б.о.м.б.а')).toBe(fuzzyKey('бомба'));
    expect(fuzzyKey('б-о-м-б-а')).toBe(fuzzyKey('бомба'));
  });

  test('Greek separator-obfuscated form matches the plain word', () => {
    expect(fuzzyKey('β.ο.μ.β.α')).toBe(fuzzyKey('βομβα'));
  });

  test('Mixed-alphabet obfuscation matches the Latin form', () => {
    expect(fuzzyKey('b.о.m.b.а')).toBe(fuzzyKey('bomba'));
    expect(fuzzyKey('b.о.m.b.а')).toBe('bomba');
  });

  test('leet folding applies to Latin runs only, not to Cyrillic words', () => {
    expect(fuzzyKey('b0mba')).toBe(fuzzyKey('bomba'));
    // Digit inside a Cyrillic word is not folded to a letter.
    expect(fuzzyKey('бо0мба')).toContain('0');
    expect(fuzzyKey('бо0мба')).not.toBe(fuzzyKey('бомба'));
  });

  test('CJK separators between characters collapse; characters are preserved', () => {
    expect(fuzzyKey('爆.弾')).toBe('爆弾');
    expect(fuzzyKey('폭-탄')).toBe('폭탄');
    expect(fuzzyKey('ばくだん')).toBe('ばくだん');
  });

  test('fullwidth Latin is normalized by NFKC before folding', () => {
    expect(fuzzyKey('ｂ．ｏ．ｍ．ｂ．ａ')).toBe('bomba');
  });

  test('different words are not merged by repeat collapsing', () => {
    expect(fuzzyKey('book')).not.toBe(fuzzyKey('bomb'));
    expect(fuzzyKey('bok')).not.toBe(fuzzyKey('bom'));
  });

  test('normalization is idempotent across alphabets and CJK', () => {
    const samples = [
      'b.o.m.b.a', 'v.z.r.y.v', 'b0mba', 'bbbomb', 'б.о.м.б.а', 'б-о-м-б-а',
      'бомба', 'β.ο.μ.β.α', 'βομβα', 'b.о.m.b.а', 'h4ck3r', 'Ünïcødé ..  x',
      '爆.弾', 'ばくだん', '폭-탄', 'ｂ．ｏ．ｍ．ｂ．ａ',
    ];
    for (const s of samples) {
      const once = fuzzyKey(s);
      expect(fuzzyKey(once)).toBe(once);
    }
  });
});

describe('fuzzyKey: extended confusables and known limits', () => {
  test('extended homoglyphs fold to their Latin lookalikes', () => {
    expect(fuzzyKey('ɡun')).toBe('gun');
    expect(fuzzyKey('ıℓ')).toBe('il');
    expect(fuzzyKey('ꭰ')).toBe('d');
    expect(fuzzyKey('Ꭰ')).toBe('d');
  });

  test('space-separated words merge after collapseSeparators (documented limit)', () => {
    expect(fuzzyKey('make a bomb')).toBe('makeabomb');
    expect(fuzzyKey('the bomb')).toBe('thebomb');
  });

  test('digits in mixed Latin tokens are partly folded (documented limit)', () => {
    expect(fuzzyKey('abc123')).toBe('abci2e');
  });

  test('repeated kana are collapsed to one character (documented limit)', () => {
    expect(fuzzyKey('ううう')).toBe('う');
  });
});

describe('unicodeTokenize', () => {
  test('splits on non-letter/non-digit runs and drops empty tokens', () => {
    expect(unicodeTokenize('  café, бомба!! [ALERT: ] 42 ')).toEqual(['café', 'бомба', 'ALERT', '42']);
    expect(unicodeTokenize('...')).toEqual([]);
  });

  test('CJK characters are kept whole; without spaces a phrase stays one token', () => {
    expect(unicodeTokenize('東京、大阪')).toEqual(['東京', '大阪']);
    expect(unicodeTokenize('こんにちは世界')).toEqual(['こんにちは世界']);
    expect(unicodeTokenize('폭탄 제조')).toEqual(['폭탄', '제조']);
  });
});
