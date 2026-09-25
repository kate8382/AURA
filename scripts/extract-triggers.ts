import fs from 'fs';
import path from 'path';
import GenerateTriggerWeights from './generate-trigger-weights';

/**
 * extract-triggers
 *
 * Lightweight, deterministic, rule-based trigger extractor (Issue #8).
 *
 * English-only. No ML, no embeddings, no TF-IDF, no external NLP libraries.
 * Inspects `scenario.text` only (never `scenario.name`, to avoid label leakage)
 * and emits trigger labels that already exist in the canonical vocabulary
 * (`config/signal-mapping.json`).
 *
 * Matching strategy (conservative, deterministic):
 *  1. Regex rules from `config/trigger-extraction.json` (case-insensitive,
 *     explicit word boundaries where needed).
 *  2. Keyword / phrase rules matched token-aware (never naive substring
 *     matching, so `research` does not match `researcher`).
 *  3. Scoring fallback: per-trigger weak-cue overlap. A trigger fires only
 *     when at least `minMatches` distinct cues co-occur AND the matched
 *     fraction reaches `threshold`. This complements explicit rules without
 *     turning every generic word into a trigger.
 *
 * Results are deduplicated and ordered by canonical vocabulary order (the
 * order triggers appear in `config/signal-mapping.json`), so output is
 * deterministic and stable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeywordRule {
  trigger: string;
  keywords?: string[];
  phrases?: string[];
  description?: string;
}

export interface RegexRule {
  trigger: string;
  pattern: string;
  description?: string;
}

export interface ScoringCueSet {
  trigger: string;
  cues: string[];
  description?: string;
}

export interface ScoringParams {
  threshold?: number;
  minMatches?: number;
}

export interface ExtractionConfig {
  description?: string;
  language?: string;
  stopwords?: string[];
  scoring?: ScoringParams;
  keywordRules?: KeywordRule[];
  regexRules?: RegexRule[];
  scoringCues?: ScoringCueSet[];
}

export interface ExtractorOptions {
  /** Override the extraction config (default: loaded from config/trigger-extraction.json). */
  config?: ExtractionConfig;
  /** Override the canonical trigger labels (default: loaded from config/signal-mapping.json). */
  canonicalTriggers?: string[];
  /** Repository root used to resolve default config paths. */
  repoRoot?: string;
}

export interface TriggerEvidence {
  trigger: string;
  via: 'regex' | 'keyword' | 'phrase' | 'scoring';
  /** Human-readable rule identity, e.g. `regex[2]`, `keyword:thesis`, `phrase:movie script`. */
  rule: string;
  /** Scoring fallback only: matchedCues / totalCues. */
  score?: number;
  /** Scoring fallback only: cues that matched. */
  matchedCues?: string[];
}

export interface DetailedExtraction {
  triggers: string[];
  evidence: TriggerEvidence[];
}

// ---------------------------------------------------------------------------
// Defaults and shared helpers
// ---------------------------------------------------------------------------

export const DEFAULT_SCORING_THRESHOLD = 0.5;
export const DEFAULT_SCORING_MIN_MATCHES = 2;

export function defaultRepoRoot(): string {
  // Prefer the current working directory when it looks like the repository
  // root (contains expected config files). This allows CLI invocations run
  // from the workspace root to resolve the same config paths as the
  // normalizer which historically used `process.cwd()`.
  const cwd = process.cwd();
  try {
    const cfgA = path.join(cwd, 'config', 'trigger-extraction.json');
    const cfgB = path.join(cwd, 'config', 'signal-mapping.json');
    if (fs.existsSync(cfgA) && fs.existsSync(cfgB)) return cwd;
  } catch (e) {
    // fallthrough to __dirname-based resolution
  }
  return path.resolve(__dirname, '..');
}

/** Shared normalizer instance so trigger identity matches downstream tooling. */
const _triggerNormalizer = new GenerateTriggerWeights();

/**
 * normalizeTriggerIdentity
 * Canonical trigger identity used for deduplication. Delegates to
 * `GenerateTriggerWeights.normalizeTrigger` (trim + lowercase + strip a
 * trailing ` request` + collapse whitespace) so extraction dedup matches the
 * identity used by trigger weighting, signal-ID mapping, and confidence.
 */
export function normalizeTriggerIdentity(t: unknown): string | null {
  return _triggerNormalizer.normalizeTrigger(t);
}

/**
 * normalizeText
 * Deterministic English text normalization: unify common apostrophe variants
 * (straight + curly) so rules do not depend on quote style, then lowercase.
 */
export function normalizeText(text: string): string {
  return text.replace(/[‘’`´]/g, "'").toLowerCase();
}

/**
 * tokenizeRaw
 * Split normalized text into alphanumeric tokens. Brackets, punctuation, and
 * placeholder markers (e.g. `[ALERT: ]`) act as separators and are tolerated.
 */
export function tokenizeRaw(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * tokenize
 * Content tokens: raw tokens minus configurable stopwords. Deterministic and
 * dependency-free. Used by the scoring fallback (overlap heuristic).
 */
export function tokenize(text: string, stopwords?: Set<string> | string[]): string[] {
  const stop = stopwords instanceof Set ? stopwords : new Set((stopwords || []).map((s) => s.toLowerCase()));
  return tokenizeRaw(text).filter((t) => !stop.has(t));
}

/** Normalize a stopword list into a lowercase token set. */
export function normalizeStopwords(stopwords: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(stopwords)) return out;
  for (const s of stopwords) {
    if (typeof s !== 'string') continue;
    const t = s.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/**
 * phraseTokenMatch
 * Contiguous token-subsequence match on raw tokens. Both the haystack and the
 * phrase go through the same tokenizer, so punctuation and spacing variants
 * (`high-fidelity`, `high fidelity`) match deterministically.
 */
function tokensOf(phrase: string): string[] {
  return tokenizeRaw(phrase);
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length === 1) return haystack.indexOf(needle[0]) !== -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// Checks if the needle tokens appear in order within a sliding window in the haystack.
function containsOrderedWithinWindow(haystack: string[], needle: string[], window = 5): boolean {
  if (needle.length === 0) return false;
  if (needle.length === 1) return haystack.indexOf(needle[0]) !== -1;
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] !== needle[0]) continue;
    // attempt to find following tokens in order within window
    let idx = i + 1;
    let matched = 1;
    for (let k = 1; k < needle.length && idx < Math.min(haystack.length, i + window + 1); idx++) {
      if (haystack[idx] === needle[k]) {
        matched++;
        k++;
      }
    }
    if (matched === needle.length) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Config loading and validation
// ---------------------------------------------------------------------------

/**
 * loadCanonicalTriggers
 * Reads the canonical trigger vocabulary from `config/signal-mapping.json`,
 * preserving first-appearance order. Throws a clear error when the mapping
 * is missing or malformed.
 */
export function loadCanonicalTriggers(repoRoot?: string): string[] {
  const root = repoRoot || defaultRepoRoot();
  const mapPath = path.join(root, 'config', 'signal-mapping.json');
  if (!fs.existsSync(mapPath)) {
    throw new Error(`extract-triggers: canonical mapping not found at ${mapPath}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (e: any) {
    throw new Error(`extract-triggers: failed to parse ${mapPath}: ${e && e.message ? e.message : e}`);
  }
  const signals = parsed && typeof parsed === 'object' ? parsed.signals : undefined;
  if (!signals || typeof signals !== 'object') {
    throw new Error(`extract-triggers: ${mapPath} has no "signals" object`);
  }
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const sid of Object.keys(signals)) {
    const val = signals[sid];
    const arr = Array.isArray(val) ? val : val && Array.isArray(val.triggers) ? val.triggers : undefined;
    if (!arr) continue;
    for (const t of arr) {
      if (typeof t !== 'string' || !t.trim() || seen.has(t)) continue;
      seen.add(t);
      labels.push(t);
    }
  }
  if (labels.length === 0) {
    throw new Error(`extract-triggers: no canonical trigger labels found in ${mapPath}`);
  }
  return labels;
}

/** Load and parse the extraction config file (without validation). */
export function loadExtractionConfigFile(repoRoot?: string): ExtractionConfig {
  const root = repoRoot || defaultRepoRoot();
  const cfgPath = path.join(root, 'config', 'trigger-extraction.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`extract-triggers: extraction config not found at ${cfgPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as ExtractionConfig;
  } catch (e: any) {
    throw new Error(`extract-triggers: failed to parse ${cfgPath}: ${e && e.message ? e.message : e}`);
  }
}

export interface ValidatedExtractionConfig {
  stopwords: Set<string>;
  threshold: number;
  minMatches: number;
  keywordRules: Array<{ trigger: string; keywords: string[][]; phrases: string[][]; rawKeywords: string[]; rawPhrases: string[] }>;
  regexRules: Array<{ trigger: string; pattern: string; regex: RegExp }>;
  scoringCues: Array<{ trigger: string; cues: string[]; cueTokens: string[][] }>;
}

/**
 * validateExtractionConfig
 * Validates the extraction config against the canonical vocabulary. Fails
 * clearly (throws) on malformed rules, invalid regex, unknown canonical
 * trigger labels, and invalid scoring parameters. Never silently accepts
 * broken configuration.
 */
export function validateExtractionConfig(
  config: ExtractionConfig,
  canonicalTriggers: string[]
): ValidatedExtractionConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('extract-triggers: extraction config must be an object');
  }
  if (!Array.isArray(canonicalTriggers) || canonicalTriggers.length === 0) {
    throw new Error('extract-triggers: canonical trigger vocabulary is empty');
  }

  // Canonical lookup by normalized identity; emission always uses the exact
  // canonical spelling from signal-mapping.json.
  const canonicalByNorm = new Map<string, string>();
  for (const label of canonicalTriggers) {
    if (typeof label !== 'string' || !label.trim()) continue;
    const n = normalizeTriggerIdentity(label);
    if (n && !canonicalByNorm.has(n)) canonicalByNorm.set(n, label);
  }

  const resolveTrigger = (section: string, index: number, trigger: unknown): string => {
    if (typeof trigger !== 'string' || !trigger.trim()) {
      throw new Error(`extract-triggers: ${section}[${index}] has a missing or invalid "trigger"`);
    }
    const n = normalizeTriggerIdentity(trigger);
    const canonical = n ? canonicalByNorm.get(n) : undefined;
    if (!canonical) {
      throw new Error(
        `extract-triggers: ${section}[${index}] references unknown canonical trigger label ${JSON.stringify(
          trigger
        )}; labels must already exist in config/signal-mapping.json`
      );
    }
    return canonical;
  };

  // -- stopwords --
  if (typeof config.stopwords !== 'undefined' && !Array.isArray(config.stopwords)) {
    throw new Error('extract-triggers: "stopwords" must be an array of strings');
  }
  const stopwords = normalizeStopwords(config.stopwords || []);
  if (Array.isArray(config.stopwords)) {
    for (const s of config.stopwords) {
      if (typeof s !== 'string') {
        throw new Error('extract-triggers: "stopwords" must be an array of strings');
      }
    }
  }

  // -- scoring params --
  let threshold = DEFAULT_SCORING_THRESHOLD;
  let minMatches = DEFAULT_SCORING_MIN_MATCHES;
  if (typeof config.scoring !== 'undefined') {
    if (!config.scoring || typeof config.scoring !== 'object' || Array.isArray(config.scoring)) {
      throw new Error('extract-triggers: "scoring" must be an object with "threshold" and "minMatches"');
    }
    if (typeof config.scoring.threshold !== 'undefined') {
      const t = config.scoring.threshold;
      if (typeof t !== 'number' || !isFinite(t) || t <= 0 || t > 1) {
        throw new Error(
          `extract-triggers: invalid scoring threshold ${JSON.stringify(t)}; expected a number in (0, 1]`
        );
      }
      threshold = t;
    }
    if (typeof config.scoring.minMatches !== 'undefined') {
      const m = config.scoring.minMatches;
      if (typeof m !== 'number' || !isFinite(m) || Math.floor(m) !== m || m < 1) {
        throw new Error(
          `extract-triggers: invalid scoring minMatches ${JSON.stringify(m)}; expected an integer >= 1`
        );
      }
      minMatches = m;
    }
  }

  // -- keyword rules --
  if (typeof config.keywordRules !== 'undefined' && !Array.isArray(config.keywordRules)) {
    throw new Error('extract-triggers: "keywordRules" must be an array');
  }
  const keywordRules: ValidatedExtractionConfig['keywordRules'] = [];
  (config.keywordRules || []).forEach((rule, i) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`extract-triggers: keywordRules[${i}] must be an object`);
    }
    const trigger = resolveTrigger('keywordRules', i, rule.trigger);
    const keywords = rule.keywords === undefined ? [] : rule.keywords;
    const phrases = rule.phrases === undefined ? [] : rule.phrases;
    if (!Array.isArray(keywords) || !Array.isArray(phrases)) {
      throw new Error(`extract-triggers: keywordRules[${i}] "keywords"/"phrases" must be arrays`);
    }
    if (keywords.length === 0 && phrases.length === 0) {
      throw new Error(`extract-triggers: keywordRules[${i}] must define at least one keyword or phrase`);
    }
    const compileTerms = (terms: unknown[], kind: string): { raw: string[]; tokenized: string[][] } => {
      const raw: string[] = [];
      const tokenized: string[][] = [];
      terms.forEach((term, j) => {
        if (typeof term !== 'string' || !term.trim()) {
          throw new Error(`extract-triggers: keywordRules[${i}] ${kind}[${j}] must be a non-empty string`);
        }
        const toks = tokensOf(term);
        if (toks.length === 0) {
          throw new Error(
            `extract-triggers: keywordRules[${i}] ${kind}[${j}] ${JSON.stringify(term)} has no matchable tokens`
          );
        }
        raw.push(term);
        tokenized.push(toks);
      });
      return { raw, tokenized };
    };
    const kw = compileTerms(keywords, 'keywords');
    const ph = compileTerms(phrases, 'phrases');
    keywordRules.push({
      trigger,
      keywords: kw.tokenized,
      phrases: ph.tokenized,
      rawKeywords: kw.raw,
      rawPhrases: ph.raw,
    });
  });

  // -- regex rules --
  if (typeof config.regexRules !== 'undefined' && !Array.isArray(config.regexRules)) {
    throw new Error('extract-triggers: "regexRules" must be an array');
  }
  const regexRules: ValidatedExtractionConfig['regexRules'] = [];
  (config.regexRules || []).forEach((rule, i) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`extract-triggers: regexRules[${i}] must be an object`);
    }
    const trigger = resolveTrigger('regexRules', i, rule.trigger);
    if (typeof rule.pattern !== 'string' || !rule.pattern) {
      throw new Error(`extract-triggers: regexRules[${i}] has a missing or invalid "pattern"`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'i');
    } catch (e: any) {
      throw new Error(
        `extract-triggers: regexRules[${i}] has invalid regex ${JSON.stringify(rule.pattern)}: ${
          e && e.message ? e.message : e
        }`
      );
    }
    regexRules.push({ trigger, pattern: rule.pattern, regex });
  });

  // -- scoring cues --
  if (typeof config.scoringCues !== 'undefined' && !Array.isArray(config.scoringCues)) {
    throw new Error('extract-triggers: "scoringCues" must be an array');
  }
  const scoringCues: ValidatedExtractionConfig['scoringCues'] = [];
  (config.scoringCues || []).forEach((set, i) => {
    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      throw new Error(`extract-triggers: scoringCues[${i}] must be an object`);
    }
    const trigger = resolveTrigger('scoringCues', i, set.trigger);
    if (!Array.isArray(set.cues) || set.cues.length === 0) {
      throw new Error(`extract-triggers: scoringCues[${i}] must define a non-empty "cues" array`);
    }
    const cues: string[] = [];
    const cueTokens: string[][] = [];
    set.cues.forEach((cue, j) => {
      if (typeof cue !== 'string' || !cue.trim()) {
        throw new Error(`extract-triggers: scoringCues[${i}] cues[${j}] must be a non-empty string`);
      }
      // Scoring cues match on content tokens (stopwords removed), so a cue
      // consisting only of stopwords can never match and is a config error.
      const toks = tokenize(cue, stopwords);
      if (toks.length === 0) {
        throw new Error(
          `extract-triggers: scoringCues[${i}] cues[${j}] ${JSON.stringify(
            cue
          )} has no content tokens after stopword removal`
        );
      }
      cues.push(cue);
      cueTokens.push(toks);
    });
    scoringCues.push({ trigger, cues, cueTokens });
  });

  // -- duplicate detection (warnings, not hard errors) --
  try {
    const regexMap = new Map<string, string[]>();
    for (const r of regexRules) {
      const arr = regexMap.get(r.pattern) || [];
      arr.push(r.trigger);
      regexMap.set(r.pattern, arr);
    }
    for (const [pat, trg] of regexMap.entries()) if (trg.length > 1)
      console.warn(`extract-triggers: duplicate regex pattern used by multiple triggers: ${pat} -> ${trg.join(', ')}`);

    const phraseMap = new Map<string, string[]>();
    for (const kr of keywordRules) {
      kr.rawPhrases.forEach((p) => {
        const arr = phraseMap.get(p) || [];
        arr.push(kr.trigger);
        phraseMap.set(p, arr);
      });
    }
    for (const [ph, trg] of phraseMap.entries()) if (trg.length > 1)
      console.warn(`extract-triggers: duplicate phrase used by multiple triggers: ${ph} -> ${trg.join(', ')}`);

    const cueMap = new Map<string, string[]>();
    for (const sc of scoringCues) {
      sc.cues.forEach((c) => {
        const arr = cueMap.get(c) || [];
        arr.push(sc.trigger);
        cueMap.set(c, arr);
      });
    }
    for (const [c, trg] of cueMap.entries()) if (trg.length > 1)
      console.warn(`extract-triggers: duplicate scoring cue used by multiple triggers: ${c} -> ${trg.join(', ')}`);
  } catch (e) {
    // best-effort warnings only
  }

  return { stopwords, threshold, minMatches, keywordRules, regexRules, scoringCues };
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export interface TriggerExtractor {
  /** Canonical labels in canonical order (for stable output ordering). */
  readonly canonicalTriggers: string[];
  /** Extract canonical trigger labels from scenario text. */
  extract(text: unknown): string[];
  /** Extract with per-trigger evidence (rule identity, scores). */
  extractDetailed(text: unknown): DetailedExtraction;
}

/**
 * createExtractor
 * Builds a validated, reusable extractor. Defaults load the repository
 * config files; tests may inject `config` and/or `canonicalTriggers`.
 */
export function createExtractor(options?: ExtractorOptions): TriggerExtractor {
  const opts = options || {};
  const canonicalTriggers = opts.canonicalTriggers || loadCanonicalTriggers(opts.repoRoot);
  const config = opts.config || loadExtractionConfigFile(opts.repoRoot);
  const validated = validateExtractionConfig(config, canonicalTriggers);

  const canonicalIndex = new Map<string, number>();
  canonicalTriggers.forEach((label, i) => {
    if (!canonicalIndex.has(label)) canonicalIndex.set(label, i);
  });

  function extractDetailed(text: unknown): DetailedExtraction {
    const found = new Map<string, TriggerEvidence>();
    const add = (ev: TriggerEvidence) => {
      if (!found.has(ev.trigger)) found.set(ev.trigger, ev);
    };
    if (typeof text !== 'string') return { triggers: [], evidence: [] };
    if (!text.trim()) return { triggers: [], evidence: [] };

    const normalized = normalizeText(text);
    const rawTokens = tokenizeRaw(text);
    const rawTokenSet = new Set(rawTokens);
    const contentTokenSet = new Set<string>();
    for (const t of rawTokens) {
      if (!validated.stopwords.has(t)) contentTokenSet.add(t);
    }
    // Prepare content tokens by filtering out stopwords from the raw tokens.
    const contentTokens = rawTokens.filter((t) => !validated.stopwords.has(t));

    // 1. Regex rules (case-insensitive; text pre-normalized for apostrophes).
    validated.regexRules.forEach((rule, i) => {
      // Reset lastIndex defensively (patterns are compiled without /g, but
      // never depend on RegExp statefulness for determinism).
      rule.regex.lastIndex = 0;
      if (rule.regex.test(normalized)) {
        add({ trigger: rule.trigger, via: 'regex', rule: `regex[${i}]: ${rule.pattern}` });
      }
    });

    // 2. Keyword / phrase rules (token-aware; never naive substring matching).
    validated.keywordRules.forEach((rule) => {
      rule.keywords.forEach((kwTokens, k) => {
        const label = rule.rawKeywords[k];
        if (kwTokens.length === 1) {
          if (rawTokenSet.has(kwTokens[0])) {
            add({ trigger: rule.trigger, via: 'keyword', rule: `keyword:${label}` });
          }
        } else if (containsTokenSequence(rawTokens, kwTokens)) {
          // Multi-token "keywords" (e.g. `self-taught`) match phrase-aware.
          add({ trigger: rule.trigger, via: 'phrase', rule: `keyword:${label}` });
        }
      });
      rule.phrases.forEach((phTokens, p) => {
        if (containsTokenSequence(rawTokens, phTokens)) {
          add({ trigger: rule.trigger, via: 'phrase', rule: `phrase:${rule.rawPhrases[p]}` });
        }
      });
    });

    // 3. Scoring fallback: stopword-aware token overlap over weak cues.
    //    score = matchedCues / totalCues; fires only when
    //    matchedCues >= minMatches AND score >= threshold, so a single
    //    generic cue can never create a trigger by itself.
    for (const set of validated.scoringCues) {
      if (found.has(set.trigger)) continue;
      const matchedCues: string[] = [];
      for (let c = 0; c < set.cues.length; c++) {
        const toks = set.cueTokens[c];
        let ok = true;
        if (toks.length === 1) {
          ok = contentTokenSet.has(toks[0]);
        } else {
          // for multi-token cues require either contiguous sequence or
          // ordered appearance within a small window in the content tokens
          if (containsTokenSequence(contentTokens, toks)) ok = true;
          else if (containsOrderedWithinWindow(contentTokens, toks, Math.max(3, toks.length + 2))) ok = true;
          else ok = false;
        }
        if (ok) matchedCues.push(set.cues[c]);
      }
      const score = matchedCues.length / set.cues.length;
      if (matchedCues.length >= validated.minMatches && score >= validated.threshold) {
        add({
          trigger: set.trigger,
          via: 'scoring',
          rule: `scoring:${matchedCues.length}/${set.cues.length} cues >= threshold ${validated.threshold}`,
          score,
          matchedCues,
        });
      }
    }

    const triggers = Array.from(found.keys()).sort((a, b) => {
      const ia = canonicalIndex.has(a) ? (canonicalIndex.get(a) as number) : Number.MAX_SAFE_INTEGER;
      const ib = canonicalIndex.has(b) ? (canonicalIndex.get(b) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { triggers, evidence: triggers.map((t) => found.get(t) as TriggerEvidence) };
  }

  function extract(text: unknown): string[] {
    return extractDetailed(text).triggers;
  }

  return { canonicalTriggers: canonicalTriggers.slice(), extract, extractDetailed };
}

// ---------------------------------------------------------------------------
// Default shared extractor (used by the normalizer)
// ---------------------------------------------------------------------------

let _sharedExtractor: TriggerExtractor | null = null;
let _sharedRepoRoot = '';

/**
 * getSharedExtractor
 * Lazily builds and caches the default repository extractor so normalizer
 * runs do not re-parse config per file. Throws clearly on broken config.
 */
export function getSharedExtractor(repoRoot?: string): TriggerExtractor {
  const root = repoRoot || defaultRepoRoot();
  if (!_sharedExtractor || _sharedRepoRoot !== root) {
    _sharedExtractor = createExtractor({ repoRoot: root });
    _sharedRepoRoot = root;
  }
  return _sharedExtractor;
}

/** Reset the shared extractor cache (primarily for tests). */
export function resetSharedExtractor(): void {
  _sharedExtractor = null;
  _sharedRepoRoot = '';
}

/**
 * extractTriggers
 * Convenience API: extract canonical trigger labels from scenario text
 * using the default repository configuration. Safe for missing/empty/
 * non-string input (returns `[]`). Throws clearly on broken configuration.
 */
export function extractTriggers(text: unknown, options?: ExtractorOptions): string[] {
  if (options && (options.config || options.canonicalTriggers)) {
    return createExtractor(options).extract(text);
  }
  return getSharedExtractor(options && options.repoRoot).extract(text);
}

/** Convenience API returning per-trigger evidence (debugging/testing). */
export function extractTriggersDetailed(text: unknown, options?: ExtractorOptions): DetailedExtraction {
  if (options && (options.config || options.canonicalTriggers)) {
    return createExtractor(options).extractDetailed(text);
  }
  return getSharedExtractor(options && options.repoRoot).extractDetailed(text);
}
