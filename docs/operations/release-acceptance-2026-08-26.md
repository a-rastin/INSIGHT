# Release Acceptance Record: 2026-08-26

## Decision

- **Synthetic engineering acceptance:** Pass
- **Clinical/research activation:** No-go
- **Application version:** `0.1.0`
- **Candidate source base:** `2f66bde8e9eaff9893ef8861e37a0bb5625a685f`
- **Candidate image:** `insight:release-acceptance`
- **Candidate image digest:** `sha256:ab229244f0726d8804f42d52d474850cad7844021f0af66a74fe92985ea9b0ae`
- **Database:** PostgreSQL 16, migration head 36

This record accepts only synthetic software behavior and operational recovery evidence. It does not
approve clinical validity, clinical safety, legal use of source material, identified Patient use, or
research activation.

## Verification Evidence

Verification ran locally on 2026-08-26 with Node.js 22.14.0 and a dedicated PostgreSQL 16 container.
No production Patient data or credentials were used.

| Gate                                                                                           | Result                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Clean dependency install                                                                       | Pass; 423 packages audited, 0 vulnerabilities  |
| Formatting, lint, type checking, unit tests, authorization inventory, OpenAPI check, and build | Pass                                           |
| Integration suite                                                                              | Pass; 90/90                                    |
| Synthetic governed vertical slice                                                              | Pass; 4/4                                      |
| Browser E2E                                                                                    | Pass; 30/30                                    |
| Role-navigation browser matrix                                                                 | Pass; 17/17                                    |
| Authentication suite                                                                           | Pass; 6/6                                      |
| Parser, transport, and abuse suite                                                             | Pass; 8/8                                      |
| Production container smoke                                                                     | Pass                                           |
| Backup/restore and rollback matrix                                                             | Pass; 6/6                                      |
| Migration compatibility                                                                        | Pass; database head 36 equals code head 36     |
| Test artifact identity and secret scan                                                         | Pass                                           |
| `npm audit --audit-level=high`                                                                 | Pass; 0 vulnerabilities                        |
| `npm audit --omit=dev --audit-level=high`                                                      | Pass; 0 vulnerabilities                        |
| Frozen DDI inventory                                                                           | Pass; 129 files in 4 batches, 0 active records |

The canonical `npm run ci` invocation completed through image build before the local 30-minute command
limit stopped that invocation. Its remaining container, E2E, and artifact gates were then run directly
and passed as listed above.

## Activation Gates

Activation remains closed for all of these independently sufficient reasons:

- BN clinical approval is not established and pathway probabilities are uncalibrated. Structural and
  deterministic software checks do not establish clinical validity.
- DDI coverage contains 0 evaluable pairs and 129 blocked records. Permission records, source
  manifests, legal approval, clinical review, and canonical medication mappings are absent.
- No attributable clinical reviewer or legal reviewer sign-off exists in the repository.
- Synthetic identifiers and test-only worker readiness used by browser acceptance do not authorize
  identified Patient creation or production research use.

Activation requires attributable records that identify reviewer, scope, source versions, findings,
decision, and timestamp. Automated test execution must not create or infer those records.

## Accepted Engineering Risks

Acceptance retains the documented architecture risks: default `admin/admin`, no forced password
change, no MFA or SSO, encryption key colocated with ciphertext, hosted-provider retention not gated,
warning-only DDI and suicide-risk results, hidden LLM imputation details, automatic medication
normalization, unchecked `UNKNOWN` interactions, immediate Patient deletion, mutable audit tables,
database-only manual backups, best-effort artifact consistency, and structural BN activation without
clinical approval. See `docs/architecture/system-architecture.md` for the authoritative inventory.

These risks do not override the activation no-go above.

## Rollback Readiness

The restore matrix verified valid full replacement, corrupt-dump rejection, version-mismatch
rejection, missing-artifact rejection, failed post-check handling, and preservation of the displaced
database for rollback. Deployment must retain the currently deployed image digest, a verified
PostgreSQL custom-format backup and manifest, and the independently protected matching artifact
volume. Follow `docs/operations/database-migrations.md`; do not improvise a down migration.

## Attestation

- **Recorded by:** OpenCode automated engineering agent
- **Recorded on:** 2026-08-26
- **Attestation:** `/s/ OpenCode`
- **Scope:** Reproduction and recording of synthetic engineering checks only

This machine attestation is not a human clinical, legal, security, privacy, or deployment-owner
signature.
