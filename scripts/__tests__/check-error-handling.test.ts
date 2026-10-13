import { findSilentCatches, outputHasError } from '../tools/check-error-handling';

describe('check-error-handling', () => {
  test('flags empty and comment-only catch blocks', () => {
    expect(findSilentCatches('try { a(); } catch (e) {}')).toHaveLength(1);
    expect(findSilentCatches('try { a(); } catch {\n  // ignore\n}')).toHaveLength(1);
    expect(findSilentCatches('x\ntry { a(); } catch (e) { /* nothing */ }')).toHaveLength(1);
  });

  test('accepts catch blocks that handle the error or are marked best-effort', () => {
    expect(findSilentCatches('try { a(); } catch (e) { logError("x", { error: e }); }')).toHaveLength(0);
    expect(findSilentCatches('try { a(); } catch (e) {\n  // best-effort: cleanup\n}')).toHaveLength(0);
    expect(findSilentCatches('// best-effort: legacy file\ntry { a(); } catch (e) { }')).toHaveLength(0);
  });

  test('reports the line of the silent catch', () => {
    expect(findSilentCatches('a();\nb();\ntry { c(); } catch (e) {}')[0].line).toBe(3);
  });

  test('detects error output in text and JSON log formats', () => {
    expect(outputHasError('[ERROR] cannot read case file file=a.json')).toBe(true);
    expect(outputHasError('{"level":"error","message":"x"}')).toBe(true);
    expect(outputHasError('[WARN] something minor')).toBe(false);
  });
});
