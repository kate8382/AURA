import fs from 'fs';
import path from 'path';
import { normalizeTriggerIdentity } from '../extract-triggers';
import { logError, logInfo, logWarn, runCli } from '../logger';

// Validation utilities for trigger extraction and signal mapping
export interface ValidationIssue {
  severity: 'error' | 'warning';
  category: 'gap' | 'duplicate' | 'overlap' | 'naming' | 'syntax';
  message: string;
  trigger?: string;
  details?: Record<string, unknown>;
}

// Statistics for validation results
export interface ValidationStats {
  canonicalTriggerCount: number;
  extractionTriggerCount: number;
  regexRuleCount: number;
  keywordRuleCount: number;
  scoringCueCount: number;
  missingRulesCount: number;
  duplicateRegexCount: number;
  duplicatePhraseCount: number;
  duplicateCueCount: number;
  duplicateKeywordCount: number;
  overlapCount: number;
  namingIssueCount: number;
}

// Validation report combining issues and statistics
export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: ValidationStats;
}

// Options for validating triggers
export interface ValidateTriggersOptions {
  repoRoot?: string;
  extractionConfigPath?: string;
  signalMappingPath?: string;
  extractionConfig?: any;
  signalMapping?: any;
  overlapThreshold?: number; // default: 0.85
  silent?: boolean;
}

// Compute the Jaccard similarity between two sets of strings (intersection over union)
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Tokenize text into lowercase words, removing stopwords and non-alphanumeric characters
export function tokenizeText(text: string, stopwords: Set<string>): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !stopwords.has(t));
}

// Extract unique lowercase content tokens from text as a Set, filtering out stopwords
export function getTokenSet(text: string, stopwords: Set<string>): Set<string> {
  return new Set(tokenizeText(text, stopwords));
}

// Main function to validate triggers based on extraction config and signal mapping
export function validateTriggers(options: ValidateTriggersOptions = {}): ValidationReport {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
  const overlapThreshold = typeof options.overlapThreshold === 'number' ? options.overlapThreshold : 0.85;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const addError = (
    category: ValidationIssue['category'],
    message: string,
    trigger?: string,
    details?: Record<string, unknown>
  ) => {
    errors.push({ severity: 'error', category, message, trigger, details });
  };

  const addWarning = (
    category: ValidationIssue['category'],
    message: string,
    trigger?: string,
    details?: Record<string, unknown>
  ) => {
    warnings.push({ severity: 'warning', category, message, trigger, details });
  };

  // 1. Load extractionConfig
  let extractionConfig = options.extractionConfig;
  if (!extractionConfig) {
    const extPath = options.extractionConfigPath || path.join(repoRoot, 'config', 'trigger-extraction.json');
    if (!fs.existsSync(extPath)) {
      addError('syntax', `trigger-extraction config file not found at ${extPath}`);
    } else {
      try {
        extractionConfig = JSON.parse(fs.readFileSync(extPath, 'utf8'));
      } catch (err: any) {
        addError('syntax', `Failed to parse ${extPath}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  // 2. Load signalMapping
  let signalMapping = options.signalMapping;
  if (!signalMapping) {
    const sigPath = options.signalMappingPath || path.join(repoRoot, 'config', 'signal-mapping.json');
    if (!fs.existsSync(sigPath)) {
      addError('syntax', `signal-mapping config file not found at ${sigPath}`);
    } else {
      try {
        signalMapping = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
      } catch (err: any) {
        addError('syntax', `Failed to parse ${sigPath}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  const emptyStats: ValidationStats = {
    canonicalTriggerCount: 0,
    extractionTriggerCount: 0,
    regexRuleCount: 0,
    keywordRuleCount: 0,
    scoringCueCount: 0,
    missingRulesCount: 0,
    duplicateRegexCount: 0,
    duplicatePhraseCount: 0,
    duplicateCueCount: 0,
    duplicateKeywordCount: 0,
    overlapCount: 0,
    namingIssueCount: 0,
  };

  if (!extractionConfig || !signalMapping) {
    return { ok: false, errors, warnings, stats: emptyStats };
  }

  // 3. Process signal-mapping canonical vocabulary
  if (!signalMapping || typeof signalMapping !== 'object' || Array.isArray(signalMapping)) {
    addError('syntax', 'signal-mapping config must be a JSON object');
    return { ok: false, errors, warnings, stats: emptyStats };
  }

  const signals = signalMapping.signals;
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) {
    addError('syntax', 'signal-mapping config must contain a "signals" object');
    return { ok: false, errors, warnings, stats: emptyStats };
  }

  const canonicalTriggersMap = new Map<string, string>(); // norm -> original
  const allCanonicalOriginals: string[] = [];

  for (const [sid, signalVal] of Object.entries(signals)) {
    if (sid.trim() !== sid) {
      addWarning('naming', `Signal ID key "${sid}" has leading or trailing whitespace`);
    }
    if (sid.toLowerCase() !== sid) {
      addWarning('naming', `Signal ID key "${sid}" contains uppercase characters: "${sid}"`);
    }
    if (signalVal && typeof signalVal === 'object' && !Array.isArray(signalVal)) {
      const objId = (signalVal as any).id;
      if (typeof objId === 'string' && objId !== sid) {
        addWarning('naming', `Signal object id "${objId}" does not match map key "${sid}"`);
      }
    }

    const trgs: unknown[] = Array.isArray(signalVal)
      ? signalVal
      : signalVal && Array.isArray((signalVal as any).triggers)
      ? (signalVal as any).triggers
      : [];

    for (const t of trgs) {
      if (typeof t !== 'string') {
        addError('syntax', `Signal "${sid}" contains non-string trigger: ${JSON.stringify(t)}`);
        continue;
      }
      if (!t.trim()) {
        addError('syntax', `Signal "${sid}" contains empty trigger string`);
        continue;
      }

      if (t.trim() !== t) {
        addWarning('naming', `Canonical trigger in signal "${sid}" has leading or trailing whitespace: "${t}"`, t);
      }
      if (/\s{2,}/.test(t)) {
        addWarning('naming', `Canonical trigger in signal "${sid}" contains consecutive whitespace: "${t}"`, t);
      }
      if (t.toLowerCase() !== t) {
        addWarning('naming', `Canonical trigger in signal "${sid}" contains uppercase characters: "${t}"`, t);
      }

      const norm = normalizeTriggerIdentity(t);
      if (norm) {
        if (canonicalTriggersMap.has(norm)) {
          addWarning(
            'duplicate',
            `Canonical trigger "${t}" is registered multiple times in signal-mapping (first registered as "${canonicalTriggersMap.get(
              norm
            )}")`,
            t
          );
        } else {
          canonicalTriggersMap.set(norm, t);
          allCanonicalOriginals.push(t);
        }
      }
    }
  }

  // 4. Process trigger-extraction rules
  if (!extractionConfig || typeof extractionConfig !== 'object' || Array.isArray(extractionConfig)) {
    addError('syntax', 'trigger-extraction config must be a JSON object');
    return { ok: false, errors, warnings, stats: emptyStats };
  }

  const stopwords = new Set<string>();
  if (Array.isArray(extractionConfig.stopwords)) {
    for (const sw of extractionConfig.stopwords) {
      if (typeof sw === 'string') stopwords.add(sw.trim().toLowerCase());
    }
  }

  const extractionTriggersSeen = new Set<string>(); // normalized
  const regexRules: any[] = Array.isArray(extractionConfig.regexRules) ? extractionConfig.regexRules : [];
  const keywordRules: any[] = Array.isArray(extractionConfig.keywordRules) ? extractionConfig.keywordRules : [];
  const scoringCues: any[] = Array.isArray(extractionConfig.scoringCues) ? extractionConfig.scoringCues : [];

  function checkRuleTrigger(rawTrigger: unknown, section: string, index: number): string | null {
    if (typeof rawTrigger !== 'string' || !rawTrigger.trim()) {
      addError('syntax', `${section}[${index}] has missing or invalid "trigger"`);
      return null;
    }
    if (rawTrigger.trim() !== rawTrigger) {
      addWarning('naming', `${section}[${index}] trigger "${rawTrigger}" has leading or trailing whitespace`, rawTrigger);
    }
    if (rawTrigger.toLowerCase() !== rawTrigger) {
      addWarning('naming', `${section}[${index}] trigger "${rawTrigger}" has uppercase characters`, rawTrigger);
    }
    if (/\s{2,}/.test(rawTrigger)) {
      addWarning('naming', `${section}[${index}] trigger "${rawTrigger}" contains consecutive whitespace`, rawTrigger);
    }

    const norm = normalizeTriggerIdentity(rawTrigger);
    if (!norm || !canonicalTriggersMap.has(norm)) {
      addError(
        'gap',
        `${section}[${index}] references unknown canonical trigger label ${JSON.stringify(
          rawTrigger
        )}; labels must exist in config/signal-mapping.json`,
        String(rawTrigger)
      );
      return null;
    }
    extractionTriggersSeen.add(norm);
    return canonicalTriggersMap.get(norm)!;
  }

  // A. Regex Rules check
  const patternMap = new Map<string, Array<{ trigger: string; index: number }>>();
  for (let i = 0; i < regexRules.length; i++) {
    const r = regexRules[i];
    if (!r || typeof r !== 'object') {
      addError('syntax', `regexRules[${i}] must be an object`);
      continue;
    }
    checkRuleTrigger(r.trigger, 'regexRules', i);

    if (typeof r.pattern !== 'string' || !r.pattern) {
      addError('syntax', `regexRules[${i}] has missing or invalid "pattern"`);
      continue;
    }

    try {
      new RegExp(r.pattern, 'i');
    } catch (err: any) {
      addError(
        'syntax',
        `regexRules[${i}] has invalid regular expression "${r.pattern}": ${err && err.message ? err.message : String(err)}`
      );
    }

    const trgName = typeof r.trigger === 'string' ? r.trigger : `<rule[${i}]>`;
    const list = patternMap.get(r.pattern) || [];
    list.push({ trigger: trgName, index: i });
    patternMap.set(r.pattern, list);
  }

  let duplicateRegexCount = 0;
  for (const [pattern, usages] of patternMap.entries()) {
    if (usages.length > 1) {
      duplicateRegexCount++;
      const trgList = usages.map((u) => u.trigger).join(', ');
      addWarning('duplicate', `Duplicate regex pattern "${pattern}" used in regexRules (triggers: ${trgList})`, undefined, {
        pattern,
        triggers: usages.map((u) => u.trigger),
      });
    }
  }

  // B. Keyword Rules check
  const phraseMap = new Map<string, string[]>();
  const keywordMap = new Map<string, string[]>();
  const allPhrasesList: Array<{ text: string; trigger: string; type: 'phrase'; tokens: Set<string> }> = [];

  for (let i = 0; i < keywordRules.length; i++) {
    const kr = keywordRules[i];
    if (!kr || typeof kr !== 'object') {
      addError('syntax', `keywordRules[${i}] must be an object`);
      continue;
    }
    const resolvedTrigger = checkRuleTrigger(kr.trigger, 'keywordRules', i) || String(kr.trigger || '');

    // phrases
    if (typeof kr.phrases !== 'undefined') {
      if (!Array.isArray(kr.phrases)) {
        addError('syntax', `keywordRules[${i}] "phrases" must be an array of strings`);
      } else {
        const seenPhraseInTrigger = new Set<string>();
        for (const p of kr.phrases) {
          if (typeof p !== 'string') {
            addError('syntax', `keywordRules[${i}] contains non-string phrase`);
            continue;
          }
          if (p.trim() !== p) {
            addWarning('naming', `Phrase in keywordRules[${i}] has leading or trailing whitespace: "${p}"`, resolvedTrigger);
          }
          const normP = p.trim().toLowerCase();
          if (seenPhraseInTrigger.has(normP)) {
            addWarning('duplicate', `Trigger "${resolvedTrigger}" has duplicate phrase "${p}" within keywordRules[${i}]`, resolvedTrigger);
          }
          seenPhraseInTrigger.add(normP);

          const list = phraseMap.get(normP) || [];
          list.push(resolvedTrigger);
          phraseMap.set(normP, list);

          const tokens = getTokenSet(p, stopwords);
          allPhrasesList.push({ text: p, trigger: resolvedTrigger, type: 'phrase', tokens });
        }
      }
    }

    // keywords
    if (typeof kr.keywords !== 'undefined') {
      if (!Array.isArray(kr.keywords)) {
        addError('syntax', `keywordRules[${i}] "keywords" must be an array of strings`);
      } else {
        const seenKwInTrigger = new Set<string>();
        for (const k of kr.keywords) {
          if (typeof k !== 'string') {
            addError('syntax', `keywordRules[${i}] contains non-string keyword`);
            continue;
          }
          if (k.trim() !== k) {
            addWarning('naming', `Keyword in keywordRules[${i}] has leading or trailing whitespace: "${k}"`, resolvedTrigger);
          }
          const normK = k.trim().toLowerCase();
          if (seenKwInTrigger.has(normK)) {
            addWarning('duplicate', `Trigger "${resolvedTrigger}" has duplicate keyword "${k}" within keywordRules[${i}]`, resolvedTrigger);
          }
          seenKwInTrigger.add(normK);

          const list = keywordMap.get(normK) || [];
          list.push(resolvedTrigger);
          keywordMap.set(normK, list);
        }
      }
    }
  }

  let duplicatePhraseCount = 0;
  for (const [p, trgs] of phraseMap.entries()) {
    if (trgs.length > 1) {
      duplicatePhraseCount++;
      addWarning('duplicate', `Duplicate phrase "${p}" used by multiple triggers in keywordRules: ${trgs.join(', ')}`, undefined, {
        phrase: p,
        triggers: trgs,
      });
    }
  }

  let duplicateKeywordCount = 0;
  for (const [k, trgs] of keywordMap.entries()) {
    if (trgs.length > 1) {
      duplicateKeywordCount++;
      addWarning('duplicate', `Duplicate keyword "${k}" used by multiple triggers in keywordRules: ${trgs.join(', ')}`, undefined, {
        keyword: k,
        triggers: trgs,
      });
    }
  }

  // C. Scoring Cues check
  const cueMap = new Map<string, string[]>();
  const triggerCuesMap = new Map<string, string[]>();
  const allCuesList: Array<{ text: string; trigger: string; type: 'scoringCue'; tokens: Set<string> }> = [];

  for (let i = 0; i < scoringCues.length; i++) {
    const sc = scoringCues[i];
    if (!sc || typeof sc !== 'object') {
      addError('syntax', `scoringCues[${i}] must be an object`);
      continue;
    }
    const resolvedTrigger = checkRuleTrigger(sc.trigger, 'scoringCues', i) || String(sc.trigger || '');

    if (typeof sc.cues !== 'undefined') {
      if (!Array.isArray(sc.cues)) {
        addError('syntax', `scoringCues[${i}] "cues" must be an array of strings`);
      } else {
        const seenCueInGroup = new Set<string>();
        for (const c of sc.cues) {
          if (typeof c !== 'string') {
            addError('syntax', `scoringCues[${i}] contains non-string cue`);
            continue;
          }
          if (c.trim() !== c) {
            addWarning('naming', `Scoring cue in scoringCues[${i}] has leading or trailing whitespace: "${c}"`, resolvedTrigger);
          }
          const normC = c.trim().toLowerCase();
          if (seenCueInGroup.has(normC)) {
            addWarning('duplicate', `Trigger "${resolvedTrigger}" has duplicate scoring cue "${c}" within scoringCues[${i}]`, resolvedTrigger);
          }
          seenCueInGroup.add(normC);

          const list = cueMap.get(normC) || [];
          list.push(resolvedTrigger);
          cueMap.set(normC, list);

          const existingTrgCues = triggerCuesMap.get(resolvedTrigger) || [];
          existingTrgCues.push(c);
          triggerCuesMap.set(resolvedTrigger, existingTrgCues);

          const tokens = getTokenSet(c, stopwords);
          allCuesList.push({ text: c, trigger: resolvedTrigger, type: 'scoringCue', tokens });
        }
      }
    }
  }

  let duplicateCueCount = 0;
  for (const [c, trgs] of cueMap.entries()) {
    if (trgs.length > 1) {
      duplicateCueCount++;
      addWarning('duplicate', `Duplicate scoring cue "${c}" used by multiple triggers in scoringCues: ${trgs.join(', ')}`, undefined, {
        cue: c,
        triggers: trgs,
      });
    }
  }

  // 5. Gap Analysis: Canonical triggers with missing extraction rules
  let missingRulesCount = 0;
  for (const orig of allCanonicalOriginals) {
    const norm = normalizeTriggerIdentity(orig);
    if (norm && !extractionTriggersSeen.has(norm)) {
      missingRulesCount++;
      addWarning('gap', `Canonical trigger has no rules in trigger-extraction.json: "${orig}"`, orig);
    }
  }

  // 6. Overlap & Collision Detection (Jaccard similarity >= overlapThreshold)
  let overlapCount = 0;

  // A. Trigger-level scoring cue token sets
  const cueTriggers = Array.from(triggerCuesMap.keys());
  for (let i = 0; i < cueTriggers.length; i++) {
    for (let j = i + 1; j < cueTriggers.length; j++) {
      const t1 = cueTriggers[i];
      const t2 = cueTriggers[j];
      const cues1 = triggerCuesMap.get(t1) || [];
      const cues2 = triggerCuesMap.get(t2) || [];
      const set1 = new Set<string>();
      const set2 = new Set<string>();
      for (const c of cues1) getTokenSet(c, stopwords).forEach((tok) => set1.add(tok));
      for (const c of cues2) getTokenSet(c, stopwords).forEach((tok) => set2.add(tok));

      if (set1.size > 0 && set2.size > 0) {
        const sim = jaccardSimilarity(set1, set2);
        if (sim >= overlapThreshold) {
          overlapCount++;
          addWarning(
            'overlap',
            `High token overlap (${(sim * 100).toFixed(1)}%) between scoring cue sets of triggers "${t1}" and "${t2}"`,
            undefined,
            { triggerA: t1, triggerB: t2, similarity: sim }
          );
        }
      }
    }
  }

  // B. Item-level phrases and cues across different triggers
  const candidateItems = [...allPhrasesList, ...allCuesList];
  for (let i = 0; i < candidateItems.length; i++) {
    for (let j = i + 1; j < candidateItems.length; j++) {
      const itemA = candidateItems[i];
      const itemB = candidateItems[j];
      if (itemA.trigger === itemB.trigger) continue;
      if (itemA.text.trim().toLowerCase() === itemB.text.trim().toLowerCase()) continue; // exact duplicate handled earlier
      if (itemA.tokens.size === 0 || itemB.tokens.size === 0) continue;

      const sim = jaccardSimilarity(itemA.tokens, itemB.tokens);
      if (sim >= overlapThreshold) {
        overlapCount++;
        addWarning(
          'overlap',
          `High token overlap (${(sim * 100).toFixed(1)}%) between [${itemA.trigger}] "${itemA.text}" (${itemA.type}) and [${
            itemB.trigger
          }] "${itemB.text}" (${itemB.type})`,
          undefined,
          { itemA, itemB, similarity: sim }
        );
      }
    }
  }

  const namingIssueCount = warnings.filter((w) => w.category === 'naming').length + errors.filter((e) => e.category === 'naming').length;

  const stats: ValidationStats = {
    canonicalTriggerCount: allCanonicalOriginals.length,
    extractionTriggerCount: extractionTriggersSeen.size,
    regexRuleCount: regexRules.length,
    keywordRuleCount: keywordRules.length,
    scoringCueCount: scoringCues.length,
    missingRulesCount,
    duplicateRegexCount,
    duplicatePhraseCount,
    duplicateCueCount,
    duplicateKeywordCount,
    overlapCount,
    namingIssueCount,
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push('=== AURA Trigger Configuration Validation ===\n');

  if (report.errors.length > 0) {
    lines.push(`Errors (${report.errors.length}):`);
    for (const err of report.errors) {
      lines.push(`  - [${err.category}] ${err.message}`);
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const warn of report.warnings) {
      lines.push(`  - [${warn.category}] ${warn.message}`);
    }
    lines.push('');
  }

  lines.push('=== Summary ===');
  lines.push(`Canonical triggers: ${report.stats.canonicalTriggerCount}`);
  lines.push(`Triggers with rules: ${report.stats.extractionTriggerCount}`);
  lines.push(`Missing rules: ${report.stats.missingRulesCount}`);
  lines.push(`Duplicate regexes: ${report.stats.duplicateRegexCount}`);
  lines.push(`Duplicate phrases: ${report.stats.duplicatePhraseCount}`);
  lines.push(`Duplicate scoring cues: ${report.stats.duplicateCueCount}`);
  if (report.stats.duplicateKeywordCount > 0) {
    lines.push(`Duplicate keywords: ${report.stats.duplicateKeywordCount}`);
  }
  lines.push(`High overlap collisions (>= threshold): ${report.stats.overlapCount}`);
  if (report.stats.namingIssueCount > 0) {
    lines.push(`Naming style issues: ${report.stats.namingIssueCount}`);
  }
  lines.push(`Total Errors: ${report.errors.length}`);
  lines.push(`Total Warnings: ${report.warnings.length}`);
  lines.push(`Result: ${report.ok ? 'PASS' : 'FAIL'}`);

  return lines.join('\n');
}

export function parseCliArgs(argv: string[]): ValidateTriggersOptions & { json?: boolean } {
  const opts: ValidateTriggersOptions & { json?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--extraction-config' || a === '-e') {
      opts.extractionConfigPath = argv[++i];
    } else if (a === '--signal-mapping' || a === '-m') {
      opts.signalMappingPath = argv[++i];
    } else if (a === '--overlap-threshold' || a === '-t') {
      opts.overlapThreshold = parseFloat(argv[++i]);
    } else if (a === '--quiet' || a === '-q') {
      opts.silent = true;
    } else if (a === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

if (require.main === module) {
  runCli(async () => {
    const opts = parseCliArgs(process.argv.slice(2));
    const report = validateTriggers(opts);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (!opts.silent) {
      console.log(formatValidationReport(report));
    }

    if (!report.ok) {
      if (!opts.json) {
        logError('trigger configuration validation failed', {
          errorCount: report.errors.length,
          warningCount: report.warnings.length,
        });
      }
      return 1;
    }

    if (!opts.json) {
      logInfo('trigger configuration validation passed', {
        warningCount: report.warnings.length,
        canonicalTriggers: report.stats.canonicalTriggerCount,
      });
    }
    return 0;
  });
}
