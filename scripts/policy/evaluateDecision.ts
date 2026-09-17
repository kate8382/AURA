import fs from 'fs';
import path from 'path';

// Policy evaluation logic for determining decisions based on configured thresholds and triggers.
type PolicyConfig = {
  review_threshold: number;
  block_threshold: number;
  failed_checks_to_review: number;
  failed_checks_to_block: number;
  override_on_failed_requirements: string;
  max_retries_before_block: number;
  veto_triggers: string[];
  default_behavior?: string;
};

export class PolicyEvaluator {
  cfg: PolicyConfig;
  constructor(cfgPath?: string) {
    const defaultPath = path.resolve(__dirname, '..', '..', 'config', 'policy.json');
    const p = cfgPath || defaultPath;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      this.cfg = JSON.parse(raw);
    } catch (err) {
      // fallback defaults
      this.cfg = {
        review_threshold: 0.6,
        block_threshold: 0.85,
        failed_checks_to_review: 1,
        failed_checks_to_block: 3,
        override_on_failed_requirements: 'review',
        max_retries_before_block: 3,
        veto_triggers: [],
        default_behavior: 'review'
      } as PolicyConfig;
    }
  }

  evaluate(caseObj: any) {
    const reasons: string[] = [];
    const confidence = (typeof caseObj.confidence === 'number') ? caseObj.confidence : 0;

    // collect triggers from scenarios
    const triggers = new Set<string>();
    if (Array.isArray(caseObj.scenarios)) {
      for (const s of caseObj.scenarios) {
        if (!s) continue;
        const tarr = Array.isArray(s.triggers) ? s.triggers : [];
        for (const t of tarr) if (typeof t === 'string') triggers.add(t.toLowerCase());
      }
    }

    // cross_check questions / history
    const questions = (caseObj.cross_check && Array.isArray(caseObj.cross_check.questions)) ? caseObj.cross_check.questions : [];
    const history = (caseObj.cross_check && Array.isArray(caseObj.cross_check.history)) ? caseObj.cross_check.history : [];
    const evasion = (caseObj.cross_check && typeof caseObj.cross_check.evasion_attempts === 'number') ? caseObj.cross_check.evasion_attempts : (caseObj.evasion_attempts || 0);

    // determine failed requirements from history
    let failedReqs = 0;
    for (const h of history) {
      if (!h) continue;
      if (h.status === 'failed') failedReqs += 1;
    }

    // pending check: if there are questions and not all answered (history less than questions)
    if (questions.length > 0 && history.length < questions.length) {
      reasons.push('Awaiting cross-check answers');
      return { decision: 'pending', reasons, confidence, failed_requirements: failedReqs };
    }

    // veto triggers
    for (const v of (this.cfg.veto_triggers || [])) {
      if (triggers.has(String(v).toLowerCase())) {
        reasons.push(`Veto trigger matched: ${v}`);
        return { decision: 'block', reasons, confidence, failed_requirements: failedReqs };
      }
    }

    // escalation by failed requirements
    if (failedReqs >= (this.cfg.failed_checks_to_block || 3)) {
      reasons.push(`Failed requirements >= ${this.cfg.failed_checks_to_block}`);
      return { decision: 'block', reasons, confidence, failed_requirements: failedReqs };
    }

    if (confidence >= (this.cfg.block_threshold || 0.85)) {
      reasons.push(`Confidence >= block_threshold (${this.cfg.block_threshold})`);
      return { decision: 'block', reasons, confidence, failed_requirements: failedReqs };
    }

    if (failedReqs >= (this.cfg.failed_checks_to_review || 1)) {
      reasons.push(`Failed requirements >= review threshold (${this.cfg.failed_checks_to_review})`);
      return { decision: 'review', reasons, confidence, failed_requirements: failedReqs };
    }

    if (confidence >= (this.cfg.review_threshold || 0.6)) {
      reasons.push(`Confidence >= review_threshold (${this.cfg.review_threshold})`);
      return { decision: 'review', reasons, confidence, failed_requirements: failedReqs };
    }

    // evasion attempts escalate
    if (evasion >= (this.cfg.max_retries_before_block || 3)) {
      reasons.push(`Evasion attempts >= max_retries_before_block (${this.cfg.max_retries_before_block})`);
      return { decision: 'block', reasons, confidence, failed_requirements: failedReqs };
    }

    reasons.push('No escalation conditions met — allow');
    return { decision: 'allow', reasons, confidence, failed_requirements: failedReqs };
  }
}

export default PolicyEvaluator;
