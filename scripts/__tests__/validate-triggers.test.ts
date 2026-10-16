import path from 'path';
import { spawnSync } from 'child_process';
import {
  validateTriggers,
  jaccardSimilarity,
  tokenizeText,
  formatValidationReport,
  ValidationReport,
} from '../tools/validate-triggers';

describe('validate-triggers', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  describe('production configs', () => {
    test('passes on current production configuration files with zero critical errors', () => {
      const report = validateTriggers({ repoRoot });
      expect(report.ok).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.stats.canonicalTriggerCount).toBeGreaterThan(0);
      expect(report.stats.extractionTriggerCount).toBeGreaterThan(0);
      // Warnings are expected (duplicate phrases and unmapped canonical triggers)
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.stats.missingRulesCount).toBeGreaterThan(0);
    });

    test('CLI execution exits with code 0 on production configs', () => {
      const res = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register', path.join(repoRoot, 'scripts', 'tools', 'validate-triggers.ts')],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Result: PASS');
      expect(res.stdout).toContain('Total Errors: 0');
    });

    test('CLI supports --json flag and outputs structured report', () => {
      const res = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register', path.join(repoRoot, 'scripts', 'tools', 'validate-triggers.ts'), '--json'],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.errors)).toBe(true);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.stats).toBeDefined();
    });
  });

  describe('gap analysis (unknown and missing triggers)', () => {
    const baseSignalMapping = {
      signals: {
        'test:alpha': {
          id: 'test:alpha',
          triggers: ['known trigger one', 'known trigger two'],
        },
      },
    };

    test('flags unknown canonical trigger in regexRules as critical error', () => {
      const badExtractionConfig = {
        regexRules: [{ trigger: 'unknown trigger x', pattern: 'some-pattern' }],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: badExtractionConfig,
      });

      expect(report.ok).toBe(false);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].category).toBe('gap');
      expect(report.errors[0].message).toContain('unknown trigger x');
    });

    test('flags unknown canonical trigger in keywordRules and scoringCues as critical error', () => {
      const badExtractionConfig = {
        keywordRules: [{ trigger: 'unknown kw trigger', phrases: ['hello world'] }],
        scoringCues: [{ trigger: 'unknown cue trigger', cues: ['cue one'] }],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: badExtractionConfig,
      });

      expect(report.ok).toBe(false);
      expect(report.errors).toHaveLength(2);
      expect(report.errors.map((e) => e.category)).toEqual(['gap', 'gap']);
      expect(report.errors[0].message).toContain('unknown kw trigger');
      expect(report.errors[1].message).toContain('unknown cue trigger');
    });

    test('warns when canonical triggers in signal-mapping lack extraction rules', () => {
      const partialExtractionConfig = {
        keywordRules: [{ trigger: 'known trigger one', phrases: ['phrase one'] }],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: partialExtractionConfig,
      });

      expect(report.ok).toBe(true);
      expect(report.errors).toHaveLength(0);
      const gapWarnings = report.warnings.filter((w) => w.category === 'gap');
      expect(gapWarnings).toHaveLength(1);
      expect(gapWarnings[0].message).toContain('known trigger two');
      expect(report.stats.missingRulesCount).toBe(1);
    });
  });

  describe('duplicate detection', () => {
    const baseSignalMapping = {
      signals: {
        'test:alpha': {
          id: 'test:alpha',
          triggers: ['trigger alpha', 'trigger beta'],
        },
      },
    };

    test('detects duplicate regex patterns across rules', () => {
      const extConfig = {
        regexRules: [
          { trigger: 'trigger alpha', pattern: 'common-pattern' },
          { trigger: 'trigger beta', pattern: 'common-pattern' },
        ],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
      });

      expect(report.ok).toBe(true);
      const dupWarnings = report.warnings.filter((w) => w.category === 'duplicate');
      expect(dupWarnings.some((w) => w.message.includes('common-pattern'))).toBe(true);
      expect(report.stats.duplicateRegexCount).toBe(1);
    });

    test('detects duplicate phrases and keywords across different triggers', () => {
      const extConfig = {
        keywordRules: [
          { trigger: 'trigger alpha', phrases: ['shared secret phrase'], keywords: ['shared_keyword'] },
          { trigger: 'trigger beta', phrases: ['shared secret phrase'], keywords: ['shared_keyword'] },
        ],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
      });

      expect(report.ok).toBe(true);
      const dupWarnings = report.warnings.filter((w) => w.category === 'duplicate');
      expect(dupWarnings.some((w) => w.message.includes('shared secret phrase'))).toBe(true);
      expect(dupWarnings.some((w) => w.message.includes('shared_keyword'))).toBe(true);
      expect(report.stats.duplicatePhraseCount).toBe(1);
      expect(report.stats.duplicateKeywordCount).toBe(1);
    });

    test('detects duplicate scoring cues across different triggers', () => {
      const extConfig = {
        scoringCues: [
          { trigger: 'trigger alpha', cues: ['identical cue'] },
          { trigger: 'trigger beta', cues: ['identical cue'] },
        ],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
      });

      expect(report.ok).toBe(true);
      const dupWarnings = report.warnings.filter((w) => w.category === 'duplicate');
      expect(dupWarnings.some((w) => w.message.includes('identical cue'))).toBe(true);
      expect(report.stats.duplicateCueCount).toBe(1);
    });

    test('detects internal duplicates within the same rule', () => {
      const extConfig = {
        keywordRules: [{ trigger: 'trigger alpha', phrases: ['phrase one', 'phrase one'] }],
        scoringCues: [{ trigger: 'trigger alpha', cues: ['cue one', 'cue one'] }],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
      });

      expect(report.ok).toBe(true);
      const dupWarnings = report.warnings.filter((w) => w.category === 'duplicate');
      expect(dupWarnings.some((w) => w.message.includes('phrase one'))).toBe(true);
      expect(dupWarnings.some((w) => w.message.includes('cue one'))).toBe(true);
    });
  });

  describe('overlap and collision detection', () => {
    const baseSignalMapping = {
      signals: {
        'test:alpha': {
          id: 'test:alpha',
          triggers: ['trigger alpha', 'trigger beta'],
        },
      },
    };

    test('warns on high token overlap (Jaccard >= threshold) between phrases across different triggers', () => {
      // 4 out of 4 tokens identical (plus one extra token): Jaccard = 4 / 5 = 0.8
      // If threshold is 0.75, should trigger overlap warning
      const extConfig = {
        stopwords: ['the', 'is', 'for'],
        keywordRules: [
          { trigger: 'trigger alpha', phrases: ['unauthorized system administration override'] },
          { trigger: 'trigger beta', phrases: ['unauthorized system administration override command'] },
        ],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
        overlapThreshold: 0.75,
      });

      expect(report.ok).toBe(true);
      const overlapWarnings = report.warnings.filter((w) => w.category === 'overlap');
      expect(overlapWarnings.length).toBeGreaterThan(0);
      expect(overlapWarnings[0].message).toContain('High token overlap');
      expect(report.stats.overlapCount).toBeGreaterThan(0);
    });

    test('warns on high token overlap between trigger-level scoring cue sets', () => {
      const extConfig = {
        stopwords: [],
        scoringCues: [
          { trigger: 'trigger alpha', cues: ['exploit payload weaponization script'] },
          { trigger: 'trigger beta', cues: ['exploit payload weaponization tool'] },
        ],
      };
      // Overlap: tokens {exploit, payload, weaponization} shared out of {exploit, payload, weaponization, script, tool}
      // 3 / 5 = 0.6. With threshold 0.5, triggers cue set overlap warning
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
        overlapThreshold: 0.5,
      });

      expect(report.ok).toBe(true);
      const overlapWarnings = report.warnings.filter((w) => w.category === 'overlap');
      expect(overlapWarnings.length).toBeGreaterThan(0);
      expect(overlapWarnings.some((w) => w.message.includes('scoring cue sets'))).toBe(true);
    });

    test('does not report overlap below threshold', () => {
      const extConfig = {
        stopwords: [],
        keywordRules: [
          { trigger: 'trigger alpha', phrases: ['completely different terms'] },
          { trigger: 'trigger beta', phrases: ['unrelated words here'] },
        ],
      };
      const report = validateTriggers({
        signalMapping: baseSignalMapping,
        extractionConfig: extConfig,
        overlapThreshold: 0.85,
      });

      const overlapWarnings = report.warnings.filter((w) => w.category === 'overlap');
      expect(overlapWarnings).toHaveLength(0);
      expect(report.stats.overlapCount).toBe(0);
    });
  });

  describe('naming consistency', () => {
    test('warns on untrimmed, consecutive whitespace, and uppercase naming in signals and rules', () => {
      const signalMapping = {
        signals: {
          'test:alpha ': {
            id: 'test:alpha',
            triggers: ['  untrimmed trigger  ', 'consecutive  spaces', 'Uppercase Trigger'],
          },
        },
      };
      const extConfig = {
        keywordRules: [
          { trigger: 'untrimmed trigger', phrases: [' valid phrase '] },
          { trigger: 'consecutive spaces', phrases: ['valid'] },
          { trigger: 'uppercase trigger', phrases: ['valid'] },
        ],
      };
      const report = validateTriggers({
        signalMapping,
        extractionConfig: extConfig,
      });

      const namingWarnings = report.warnings.filter((w) => w.category === 'naming');
      expect(namingWarnings.length).toBeGreaterThan(0);
      expect(report.stats.namingIssueCount).toBeGreaterThan(0);
    });
  });

  describe('syntax and structure validation', () => {
    test('flags invalid regex patterns as critical errors', () => {
      const signalMapping = {
        signals: {
          'test:alpha': { id: 'test:alpha', triggers: ['trigger alpha'] },
        },
      };
      const extConfig = {
        regexRules: [{ trigger: 'trigger alpha', pattern: '[unclosed regex(' }],
      };
      const report = validateTriggers({
        signalMapping,
        extractionConfig: extConfig,
      });

      expect(report.ok).toBe(false);
      const syntaxErrors = report.errors.filter((e) => e.category === 'syntax');
      expect(syntaxErrors.length).toBeGreaterThan(0);
      expect(syntaxErrors[0].message).toContain('invalid regular expression');
    });

    test('handles missing config files with syntax errors', () => {
      const report = validateTriggers({
        extractionConfigPath: '/non/existent/path/trigger-extraction.json',
        signalMappingPath: '/non/existent/path/signal-mapping.json',
      });
      expect(report.ok).toBe(false);
      expect(report.errors.length).toBe(2);
      expect(report.errors[0].category).toBe('syntax');
    });
  });

  describe('helper functions', () => {
    test('jaccardSimilarity calculates set similarity correctly', () => {
      expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
      expect(jaccardSimilarity(new Set(['a']), new Set(['a']))).toBe(1);
      expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
      expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']))).toBe(2 / 4);
    });

    test('tokenizeText strips punctuation and stopwords correctly', () => {
      const stopwords = new Set(['the', 'and']);
      const tokens = tokenizeText("The quick, brown fox! And it's running.", stopwords);
      expect(tokens).toEqual(['quick', 'brown', 'fox', 'it', 's', 'running']);
    });

    test('formatValidationReport formats reports cleanly for both pass and fail', () => {
      const reportPass: ValidationReport = {
        ok: true,
        errors: [],
        warnings: [{ severity: 'warning', category: 'gap', message: 'test warning' }],
        stats: {
          canonicalTriggerCount: 10,
          extractionTriggerCount: 9,
          regexRuleCount: 2,
          keywordRuleCount: 3,
          scoringCueCount: 4,
          missingRulesCount: 1,
          duplicateRegexCount: 0,
          duplicatePhraseCount: 0,
          duplicateCueCount: 0,
          duplicateKeywordCount: 0,
          overlapCount: 0,
          namingIssueCount: 0,
        },
      };
      const text = formatValidationReport(reportPass);
      expect(text).toContain('Result: PASS');
      expect(text).toContain('Warnings (1):');
      expect(text).toContain('Canonical triggers: 10');

      const reportFail: ValidationReport = {
        ...reportPass,
        ok: false,
        errors: [{ severity: 'error', category: 'gap', message: 'critical error message' }],
      };
      const textFail = formatValidationReport(reportFail);
      expect(textFail).toContain('Result: FAIL');
      expect(textFail).toContain('Errors (1):');
      expect(textFail).toContain('critical error message');
    });
  });
});
