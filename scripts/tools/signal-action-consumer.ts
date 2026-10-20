import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');
const signalMappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');

// Retrieves the implied actions for a given signal ID, optionally filtering by known action classes.
export function getImpliedActions(signalId: string, knownActionClasses?: string[]): string[] {
  if (!signalId || typeof signalId !== 'string') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(signalMappingPath, 'utf8'));
  } catch {
    return [];
  }

  const signal = parsed && parsed.signals && parsed.signals[signalId];
  if (!signal || !Array.isArray(signal.implied_action)) return [];

  const valid = signal.implied_action.filter((value: unknown) => typeof value === 'string');
  if (!knownActionClasses || knownActionClasses.length === 0) return valid;

  const allowed = new Set(knownActionClasses.filter((item) => typeof item === 'string'));
  return valid.filter((value: string) => allowed.has(value));
}
