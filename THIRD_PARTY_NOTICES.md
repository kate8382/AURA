# Third-party notices

This file lists third-party **software** used by AURA and the licence terms that
apply to it. It is an attribution and compliance record, not a legal opinion.
Data-source attribution lives in [`real_cases/NOTICE.md`](real_cases/NOTICE.md)
and [`docs/DATA_HANDLING_POLICY.md`](docs/DATA_HANDLING_POLICY.md).

## Runtime dependencies

### OpenPGP.js (`openpgp`) 6.3.2

| | |
| --- | --- |
| Package | `openpgp` (OpenPGP.js) |
| Version | **6.3.2** (pinned exactly in `package.json`; no caret range) |
| Licence | `LGPL-3.0+` as declared in the package metadata, i.e. **LGPL-3.0-or-later** |
| Upstream | <https://github.com/openpgpjs/openpgpjs> — <https://openpgpjs.org/> |
| Installed from | npm registry tarball `openpgp-6.3.2.tgz` (lockfile integrity hash pinned) |
| Runtime | Node.js `>= 18.0.0`, TypeScript `>= 5.0.0` (declared by the package) |
| Transitive dependencies | none (the package itself declares no `dependencies`) |
| Use in AURA | cryptographic signature verification for the `pgp-verify` cross-check adapter (`scripts/policy/pgp/`) |
| Modifications | none — the package is consumed unmodified |

**Obligations that follow from LGPL-3.0-or-later.** Because AURA distributes the
library as part of its own source distribution, the following apply, at minimum:

1. The full text of the LGPL-3.0 licence (and of the GPL-3.0 it references) must
   accompany the distribution. Obtain the authoritative texts from
   <https://www.gnu.org/licenses/lgpl-3.0.txt> and
   <https://www.gnu.org/licenses/gpl-3.0.txt>; the copy shipped inside the npm
   package is `node_modules/openpgp/LICENSE`.
2. Copyright and licence notices must be preserved.
3. Modifications to the library must be documented and the modified library
   source made available under the same licence. AURA does not modify it.
4. Users must be able to replace/relink the library. AURA consumes it as an
   ordinary, unmodified npm dependency resolved at install time from the public
   registry, so the library is a separately replaceable component rather than a
   statically inlined derivative. Any future bundling, minification or vendoring
   of OpenPGP.js into a distributed artifact should be re-reviewed against this
   requirement before it ships.
5. LGPL-3.0 grants patent-use rights and requires that any patent licence you
   receive for the library extend to downstream users.

**Scope note.** AURA itself is distributed under the Business Source Licence
1.1 (change licence: Apache-2.0 on 2029-10-05), with data under CC-BY-NC-4.0.
Whether and how the LGPL-3.0 obligations combine with those terms is a legal
question for the project owner (and, for commercial use, for qualified counsel).
This file records the facts and the obligations that clearly apply; it does not
assert that any particular combination is legally sufficient.

## Development-only dependencies

These are not part of any runtime artifact; they are listed for completeness:

| Package | Licence |
| --- | --- |
| `typescript` | Apache-2.0 |
| `ts-node` | MIT |
| `ts-jest` | MIT |
| `jest` | MIT |
| `@types/node`, `@types/jest` | MIT |
| `ajv` | MIT |

## Review date

Recorded when the `pgp-verify` adapter was added. Re-verify the version,
licence metadata and dependency tree (`npm ls openpgp`, `npm view openpgp
license`) whenever the dependency is upgraded.
