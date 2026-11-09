---
name: Bug report
about: Report a reproducible bug in scripts, validators, or case schema
title: "bug: "
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what the bug is.

**Command run**
<!-- e.g. `npm run validate:real`, `npm run recalc:confidence` -->

**To Reproduce**
1. Go to '...'
2. Run `npm run ...`
3. Observe the error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Logs**
Run with JSON logging and paste the relevant output (remove any sensitive data):
```
AURA_LOG_FORMAT=json <command>
```

**Environment**
- OS: (e.g. Windows 11, macOS 14, Ubuntu 24.04)
- Node.js version: (output of `node -v`)
- AURA commit/ref: (output of `git rev-parse --short HEAD`)

**Additional context**
Anything else that helps reproduce the problem.
