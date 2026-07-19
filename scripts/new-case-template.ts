import fs from 'fs/promises';
import path from 'path';

// NewCaseTemplate - класс для создания шаблона нового кейса с каноническим порядком ключей.
export class NewCaseTemplate {
  createTemplate(caseId?: string) {
    const id = caseId || `X-CASE-000`;
    // Поля упорядочены намеренно: confidence_raw до scenarios; confidence идёт после cross_check
    const tpl: any = {
      case_id: id,
      category: "",
      confidence_raw: 0.5,
      scenarios: [
        { name: "", text: "", triggers: [] },
        { name: "", text: "", triggers: [] },
        { name: "", text: "", triggers: [] }
      ],
      suggested_action: "cross_check",
      legal_risk: { short_summary: "", full_text: [] },
      behavioral_patterns: { short_summary: "Behavioral Patterns (Signals)", full_text: [""] },
      cross_check: {
        short_summary: "Cross-Checking",
        questions: [
          { name: "", full_text: ["A: ", "B: "] },
          { name: "", full_text: ["A: ", "B: "] },
          { name: "3. Direct Absurdity Callout", full_text: [""] }
        ]
      },
      confidence: 0.95,
      deception_threshold: {
        short_summary: "Deception Threshold",
        full_text: [
          { name: "1. Red Flag 1 ()", full_text: ["A: ", "B: "] },
          { name: "Red Flag 2 (Persona Shift)", full_text: ["A: ", "B: "] },
          { name: "3. Block Trigger (100% Risk)", full_text: ["A: ", "B: ", "Action: "] }
        ]
      }
    };
    return tpl;
  }

  async writeTemplate(outDir = process.env.CASES_DIR || 'public_cases', caseId?: string, dryRun = false) {
    const tpl = this.createTemplate(caseId);
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
  const T = new NewCaseTemplate();
  T.writeTemplate(outDir, caseId, dry).catch(err => { console.error(err); process.exit(1); });
}
