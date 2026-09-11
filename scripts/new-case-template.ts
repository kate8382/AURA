import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { PROMPT_BASE } from './recalc_confidence';

// NewCaseTemplate - класс для создания шаблона нового кейса с каноническим порядком ключей.
export class NewCaseTemplate {
  createTemplate(caseId?: string) {
    const id = caseId || `X-CASE-000`;
    // Поля упорядочены намеренно: confidence_raw до scenarios; confidence идёт после cross_check
    const tpl: any = {
      case_id: id,
      category: "",
      confidence_raw: PROMPT_BASE,
      signal_ids: [],
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
      confidence: PROMPT_BASE,
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

  async writeTemplate(outDir = process.env.CASES_DIR || 'public_cases', caseId?: string, dryRun = false, sectionLetter?: string, seqNumber?: number, autoSeq = false) {
    const tpl = this.createTemplate(caseId);
    const fileNameBase = `${tpl.case_id}.json`;
    // If outDir exists and contains subdirectories, allow mapping by initial letter
    let finalOutDir = outDir;
    let letter = sectionLetter;
    try {
      const stats = await fs.stat(outDir);
      if (stats.isDirectory()) {
        const entries = await fs.readdir(outDir, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(d => d.name);
        if (dirs.length > 0) {
          if (!letter) {
            // interactive prompt if running in TTY
            if (process.stdin.isTTY) {
              letter = await new Promise<string | undefined>(resolve => {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question('Enter initial letter for target subfolder (or press Enter to skip): ', answer => {
                  rl.close();
                  resolve(answer ? answer.trim() : undefined);
                });
              });
            }
          }
          if (letter) {
            const match = dirs.find(d => d[0].toLowerCase() === letter!.toLowerCase());
            if (match) finalOutDir = path.join(outDir, match);
            else {
              // prompt user for folder action: create single-letter folder or enter custom name
              if (process.stdin.isTTY) {
                const answer = await new Promise<string | undefined>(resolve => {
                  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                  rl.question(`No existing folder matches '${letter!.toUpperCase()}'. Enter folder name to create (or press Enter to create single-letter folder '${letter!.toUpperCase()}'): `, ans => {
                    rl.write('\n');
                    rl.close();
                    resolve(ans ? ans.trim() : undefined);
                  });
                });
                if (answer) finalOutDir = path.join(outDir, answer.toUpperCase());
                else finalOutDir = path.join(outDir, letter!.toUpperCase());
              } else {
                finalOutDir = path.join(outDir, letter.toUpperCase());
              }
            }
          }
        } else {
          // no named dirs present
          if (letter) finalOutDir = path.join(outDir, letter.toUpperCase());
        }
      }
    } catch (err) {
      // outDir may not exist yet — create letter subfolder later when writing
      if (letter) finalOutDir = path.join(outDir, letter.toUpperCase());
    }

    // If letter was determined (either param or interactive) and no explicit id, inject into case_id
    if (!caseId && letter) {
      const L = letter.toUpperCase();
      let seq = seqNumber;

      // If interactive and no seq requested, ask user for number or auto
      if (process.stdin.isTTY && typeof seq === 'undefined' && !autoSeq) {
        const resp = await new Promise<string | undefined>(resolve => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(`Enter sequence number (e.g. 1), or 'a' to auto-increment, or press Enter to keep 000: `, ans => {
            rl.close();
            resolve(ans ? ans.trim() : undefined);
          });
        });
        if (resp) {
          if (/^a(uto)?$/i.test(resp)) autoSeq = true;
          else if (/^\d+$/.test(resp)) seq = parseInt(resp, 10);
        }
      }

      if (autoSeq) {
        try {
          const files = await fs.readdir(finalOutDir);
          let max = 0;
          for (const f of files) {
            const m = f.match(new RegExp(`^${L}-CASE-(\\d+)\\.json$`));
            if (m) {
              const n = parseInt(m[1], 10);
              if (!Number.isNaN(n) && n > max) max = n;
            }
          }
          seq = max + 1;
        } catch (err) {
          seq = 1; // start from 1 -> 001
        }
      }
      if (typeof seq === 'number') {
        const numStr = String(seq).padStart(3, '0');
        tpl.case_id = `${L}-CASE-${numStr}`;
      } else {
        tpl.case_id = tpl.case_id.replace(/^./, L);
      }
    }
    const outPath = path.resolve(process.cwd(), finalOutDir, `${tpl.case_id}.json`);
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
  let sectionLetter: string | undefined;
  let seqNumber: number | undefined;
  let autoSeq = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') outDir = argv[++i];
    else if (a === '-i' || a === '--id') caseId = argv[++i];
    else if (a === '--dry-run') dry = true;
    else if (a === '-l' || a === '--letter') {
      // allow passing section initial letter from CLI
      const v = argv[++i];
      if (v) sectionLetter = v;
    } else if (a === '-n' || a === '--number') {
      const v = argv[++i];
      if (v && /^\d+$/.test(v)) seqNumber = parseInt(v, 10);
    } else if (a === '-a' || a === '--auto') {
      autoSeq = true;
    }
  }
  const T = new NewCaseTemplate();
  T.writeTemplate(outDir, caseId, dry, sectionLetter, seqNumber, autoSeq).catch(err => { console.error(err); process.exit(1); });
}
