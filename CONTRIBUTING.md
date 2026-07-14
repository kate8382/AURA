CONTRIBUTING to AURA
=====================

Thanks for your interest in contributing. This document describes the minimal workflow for contributions, licensing, and private/premium
content handling.

Licenses
- Code (scripts, tooling): Apache-2.0
- Public cases (content in `public_cases/`): CC BY-NC 4.0

If you submit a contribution (code or data), you agree that your contribution will be made available under the repository license above.

Basic workflow
1. Fork the repository (if you are an external contributor).
2. Create a feature branch with a descriptive name: `feature/xyz` or
   `fix/bug-123`.
3. Implement changes and add tests where appropriate.
4. Ensure linters/tests pass locally: `npm install` and `npm test`.
5. Open a pull request with a clear description and link to related
   issues. Maintainership will review and request changes if needed.

Private / Premium content workflow (for maintainers)
- Keep paid/premium cases in a private branch or private repository.
  Recommended pattern:
  - `main` — public, open-core code and `public_cases/` (CC BY-NC 4.0)
  - `private-cases` — private branch/repo with premium cases (access
    by contract / commercial license only)

Creating a private branch (example)
```bash
# create a local branch from main
git checkout -b private-cases
# do work, add files
git add path/to/new-case.json
git commit -m "Add premium case: XYZ"
# push branch to remote (private repository or protected branch)
git push origin private-cases
```

When collaborating with others privately, share access through a separate private repository or by granting direct access to the
`private-cases` branch on your Git host (recommended: use a private repo). **Do NOT** push premium content to the public repository.

Contributor License Agreement (optional)
- If you expect many external contributions or want the right to
  re-license code/data later, consider using a simple CLA. For now,
  contributions are accepted under the repository license by default.

Code style and tests
- Use TypeScript formatting and `ts-node` for scripts.
- Add unit tests in `scripts/__tests__/` with Jest.
- Run `npm test` before opening PRs.

Contact
- For commercial licensing, email: contact@aura-security.io (placeholder)
