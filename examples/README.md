Examples for running small end-to-end demos using AURA scripts.

examples/ contains a minimal valid `sample_case.json` and a small CLI wrapper
`simple-recalc.ts` that runs the project's `recalc_confidence` pipeline on a single
case file. The wrapper is intentionally lightweight and uses the project's
internal scripts so behavior matches production.

Requirements
- Node.js 18+ (project uses `ts-node` to run TypeScript entrypoints)
- `npm install` to ensure devDependencies (`ts-node`, `typescript`) are available

Quickstart

1. Run the example with pretty output:

```bash
npm run example:recalc
```

2. Run example with trigger extraction and JSON output:

```bash
node -r ts-node/register examples/simple-recalc.ts examples/sample_case.json --extract-triggers --out json
```

Expected Output (pretty):

Case: EX-EXAMPLE-001
Category: access/example
Confidence: 0.42 (raw: 0.87)
Decision: review
Decision reasons: cross-check-failed; urgent-request
Scenarios and triggers:
 - Initial contact
   triggers: urgency / pressure
 - Follow-up
   triggers: actionable payload
