import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  DDI_TRANSFORM_VERSION,
  DdiSourceAuthorizationError,
  DdiSourceInputError,
  DdiSourceLifecycleError,
  MEDSCAPE_PARSER_VERSION,
  assertActivationAuthorized,
  assertLifecycleTransition,
  extractMedscapeInteractions,
  importDdiSource,
  sha256,
  validateDdiSourceManifest,
} from "../.tsbuild/server/index.js";

const fixture = new TextEncoder().encode(`clozapine (Rx)
Interactions

Contraindicated (1)
• thioridazine: Both increase QTc interval.
Serious (1)
• carbamazepine: Decreases clozapine levels and increases risk of agranulocytosis.
Monitor Closely (1)
• lorazepam: Additive CNS depression.
Minor (1)
• ethanol: Additive CNS depression.

Adverse Effects
Not interaction evidence.`);

function manifest(permissionStatus = "granted") {
  return {
    drugIdentity: "RXNORM.2626",
    title: "Clozapine Drug Information",
    url: "https://reference.medscape.com/drug/clozaril-versacloz-clozapine-342972",
    publisher: "Medscape",
    retrievedAt: "2026-08-20T10:00:00.000Z",
    contentDate: "2026-08-19",
    sha256: sha256(fixture),
    parserVersion: MEDSCAPE_PARSER_VERSION,
    transformVersion: DDI_TRANSFORM_VERSION,
    reviewerId: "clinical-reviewer-1",
    reviewedAt: "2026-08-21T10:00:00.000Z",
    reviewReference: "review://ddi/clozapine/1",
    permission: {
      status: permissionStatus,
      basis: "Written permission for test fixture",
      recordReference: "legal://medscape/permission/1",
      coversStorage: permissionStatus === "granted",
      coversTransformation: permissionStatus === "granted",
      coversResearchUse: permissionStatus === "granted",
    },
    lifecycle: "quarantined",
  };
}

test("manifest validation and SHA-256 reject incomplete or changed artifacts", () => {
  assert.equal(validateDdiSourceManifest(manifest()).sha256, sha256(fixture));
  assert.throws(() => validateDdiSourceManifest({ ...manifest(), title: "" }), DdiSourceInputError);
  assert.notEqual(sha256(new TextEncoder().encode("changed")), manifest().sha256);
});

test("versioned parser fixture extracts deterministic evidence text references", () => {
  const left = extractMedscapeInteractions(fixture, sha256(fixture));
  const right = extractMedscapeInteractions(fixture, sha256(fixture));
  assert.deepEqual(left, right);
  assert.deepEqual(
    left.map(({ severity, evidenceText, evidenceReference }) => [
      severity,
      evidenceText,
      evidenceReference.lineStart,
      evidenceReference.sourceSha256,
    ]),
    [
      ["contraindicated", "• thioridazine: Both increase QTc interval.", 5, sha256(fixture)],
      [
        "serious",
        "• carbamazepine: Decreases clozapine levels and increases risk of agranulocytosis.",
        7,
        sha256(fixture),
      ],
      ["monitor_closely", "• lorazepam: Additive CNS depression.", 9, sha256(fixture)],
      ["minor", "• ethanol: Additive CNS depression.", 11, sha256(fixture)],
    ],
  );
});

test("lifecycle and activation gates reject skips, missing approval refs, and unlicensed content", () => {
  assert.doesNotThrow(() => assertLifecycleTransition("quarantined", "reviewed"));
  assert.throws(() => assertLifecycleTransition("quarantined", "active"), DdiSourceLifecycleError);
  const reviewed = { lifecycle: "reviewed", manifest: manifest() };
  assert.throws(() => assertActivationAuthorized(reviewed, "", "clinical://approval/1"));
  assert.throws(
    () =>
      assertActivationAuthorized(
        { lifecycle: "reviewed", manifest: manifest("not_granted") },
        "legal://approval/1",
        "clinical://approval/1",
      ),
    /permission/,
  );
  assert.doesNotThrow(() =>
    assertActivationAuthorized(reviewed, "legal://approval/1", "clinical://approval/1"),
  );
});

test("artifact import is Administrator-only before any database or extraction work", async () => {
  await assert.rejects(
    importDdiSource(
      {},
      { id: "00000000-0000-4000-8000-000000000001", role: "PSYCHIATRIST" },
      { manifest: manifest(), artifact: fixture },
    ),
    DdiSourceAuthorizationError,
  );
});
