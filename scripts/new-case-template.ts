import fs from 'fs/promises';
import path from 'path';

export type CaseTemplate = {
  export_date: string;
  source: string;
  anonymized: boolean;
  case_id: string;
  category: string;
  scenarios: Array<{ name: string; text: string; triggers: string[] }>;
  confidence: number;
  confidence_raw?: number;
  suggested_action?: string;
  legal_risk: { short_summary: string; full_text: string[] | string };
  behavioral_patterns: { short_summary: string; full_text: string[] };
  cross_check: { short_summary: string; questions: Array<{ name: string; full_text: string[] }> };
  deception_threshold: { short_summary: string; full_text: any[] };
};

export function createTemplate(caseId?: string): CaseTemplate {
  const id = caseId || `CASE-${Date.now()}`;
  return {
    export_date: new Date().toISOString().split('T')[0],
    source: 'AURA',
    anonymized: true,
    case_id: id,
    category: '',
    scenarios: [
      {
        name: '',
        text: '',
        triggers: []
      }
    ],
    confidence: 0.5,
    confidence_raw: 0.5,
    suggested_action: '',
    legal_risk: {
      short_summary: '',
      full_text: []
    },
    behavioral_patterns: {
      short_summary: '',
      full_text: []
    },
    cross_check: {
      short_summary: '',
      questions: []
    },
    deception_threshold: {
      short_summary: '',
      full_text: []
    }
  };
}

async function writeTemplate(outDir = process.env.CASES_DIR || 'public_cases', caseId?: string, dryRun = false) {
  const tpl = createTemplate(caseId);
  const fileName = `${tpl.case_id}.json`;
  const outPath = path.resolve(process.cwd(), outDir, fileName);
  if (dryRun) {
    console.log('[dry] would write to', outPath);
    console.log(JSON.stringify(tpl, null, 2));
    return;
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(tpl, null, 2), 'utf8');
  console.log('WROTE', outPath);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let outDir = process.env.CASES_DIR || 'public_cases';
  let caseId: string | undefined;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') outDir = argv[++i];
    else if (a === '-i' || a === '--id') caseId = argv[++i];
    else if (a === '--dry-run') dry = true;
  }
  writeTemplate(outDir, caseId, dry).catch(err => { console.error(err); process.exit(1); });
}

export default createTemplate;
