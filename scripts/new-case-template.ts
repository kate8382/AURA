import fs from 'fs/promises';
import path from 'path';

export type CaseTemplate = {
  case_id: string;
  category: string;
  scenarios: Array<{ name: string; text: string; triggers: string[] }>;
  confidence: number;
  suggested_action?: string;
  legal_risk: { short_summary: string; full_text: string[] | string };
  behavioral_patterns: { short_summary: string; full_text: string[] };
  cross_check: { short_summary: string; questions: Array<{ name: string; full_text: string[] }> };
  deception_threshold: { short_summary: string; full_text: any[] };
  confidence_raw?: number;
};

export function createTemplate(caseId?: string): CaseTemplate {
  const id = caseId || `AUTO-CASE-000`;
  return {
    "case_id": id,
    "category": "",
    "scenarios": [
      {
        "name": "",
        "text": "",
        "triggers": []
      },
      {
        "name": "",
        "text": "",
        "triggers": []
      },
      {
        "name": "",
        "text": "",
        "triggers": []
      }
    ],
    "confidence": 0.5,
    "suggested_action": "cross_check",
    "legal_risk": {
      "short_summary": "",
      "full_text": ""
    },
    "behavioral_patterns": {
      "short_summary": "Behavioral Patterns (Signals)",
      "full_text": [""]
    },
    "cross_check": {
      "short_summary": "Cross-Checking",
      "questions": [
        {
          "name": "",
          "full_text": [
            "A: ",
            "B: "
          ]
        },
        {
          "name": "",
          "full_text": [
            "A: ",
            "B: "
          ]
        },
        {
          "name": "3. Direct Absurdity Callout",
          "full_text": [
            ""
          ]
        },
      ]
    },
    "deception_threshold": {
      "short_summary": "Deception Threshold",
      "full_text": [
        {
          "name": "1. Red Flag 1 ()",
          "full_text": [
            "A: ",
            "B: "
          ]
        },
        {
          "name": "Red Flag 2 (Persona Shift)",
          "full_text": [
            "A: ",
            "B: "
          ]
        },
        {
          "name": "3. Block Trigger (100% Risk)",
          "full_text": [
            "A: ",
            "B: ",
            "Action: "
          ]
        }
      ]
    },
    "confidence_raw": 0.5
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
