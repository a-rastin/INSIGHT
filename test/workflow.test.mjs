import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_COMMANDS,
  WORKFLOW_STATES,
  WORKFLOW_TRANSITIONS,
} from "../.tsbuild/server/index.js";

const expected = new Map([
  ["DATA_COLLECTION:BEGIN_NORMALIZATION", "NORMALIZING_MEDICATIONS"],
  ["NORMALIZING_MEDICATIONS:COMPLETE_MEDICATION_NORMALIZATION", "IMPUTING_BYPASSED_ASSESSMENTS"],
  ["IMPUTING_BYPASSED_ASSESSMENTS:COMPLETE_ASSESSMENT_IMPUTATION", "ROUTING_BN"],
  ["ROUTING_BN:COMPLETE_BN_ROUTING", "GENERATING_CPTS"],
  ["GENERATING_CPTS:COMPLETE_CPT_GENERATION", "RUNNING_BN"],
  ["RUNNING_BN:COMPLETE_BN_INFERENCE", "CHECKING_PRIMARY_DDI"],
  ["CHECKING_PRIMARY_DDI:COMPLETE_PRIMARY_DDI", "GENERATING_PRIMARY_PLAN"],
  ["GENERATING_PRIMARY_PLAN:COMPLETE_PRIMARY_PLAN", "CLINICIAN_REVIEW"],
  ["CLINICIAN_REVIEW:REQUEST_FINAL_DDI_RECHECK", "RECHECKING_FINAL_DDI"],
  ["CLINICIAN_REVIEW:CONFIRM_UNCHANGED_REGIMEN", "READY_TO_FINALIZE"],
  ["RECHECKING_FINAL_DDI:COMPLETE_FINAL_DDI", "READY_TO_FINALIZE"],
  ["READY_TO_FINALIZE:FINALIZE", "FINALIZED"],
  ["FINALIZED:CREATE_REVISION_DRAFT", "REVISION_DRAFT"],
  ["REVISION_DRAFT:REQUEST_REVISION_DDI_RECHECK", "RECHECKING_FINAL_DDI"],
]);

test("Research Case transition table exhaustively permits only architecture edges", () => {
  const actual = new Map(
    WORKFLOW_TRANSITIONS.map(({ from, command, to }) => [`${from}:${command}`, to]),
  );
  assert.deepEqual(actual, expected);
  assert.equal(actual.size, WORKFLOW_TRANSITIONS.length, "duplicate state/command pair");

  for (const state of WORKFLOW_STATES) {
    for (const command of WORKFLOW_COMMANDS) {
      const key = `${state}:${command}`;
      assert.equal(actual.get(key), expected.get(key), key);
    }
  }
});
