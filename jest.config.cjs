module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/scripts/**/?(*.)+(spec|test).[jt]s?(x)'],
  // Per-file thresholds only (no global threshold). Applied when coverage is collected.
  coverageThreshold: {
    './scripts/validators/validate-percases.ts': { statements: 85, branches: 75 },
    './scripts/generators/recalc_confidence.ts': { statements: 85, branches: 75 }
  }
};
