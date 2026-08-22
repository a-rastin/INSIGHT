import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAge,
  normalizeOfficialIdentifier,
  officialIdentifierConfigurationFromEnv,
} from "../.tsbuild/server/index.js";

const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};

test("Patient calendar age handles birthdays and leap dates", () => {
  assert.equal(calculateAge("2000-08-22", "2026-08-21"), 25);
  assert.equal(calculateAge("2000-08-22", "2026-08-22"), 26);
  assert.equal(calculateAge("2000-02-29", "2023-02-28"), 22);
  assert.equal(calculateAge("2000-02-29", "2023-03-01"), 23);
  assert.equal(calculateAge("2000-02-29", "2024-02-29"), 24);
  assert.throws(() => calculateAge("2026-02-29", "2026-08-22"), /valid calendar date/);
});

test("official identifier configuration controls normalization and format", () => {
  assert.equal(
    normalizeOfficialIdentifier(" synthetic-000001 ", identifierConfiguration),
    "SYNTHETIC-000001",
  );
  assert.throws(
    () => normalizeOfficialIdentifier("not-accepted", identifierConfiguration),
    /deployment configuration/,
  );
  assert.deepEqual(
    officialIdentifierConfigurationFromEnv({
      INSIGHT_OFFICIAL_IDENTIFIER_TYPE: "RESEARCH_ID",
      INSIGHT_OFFICIAL_IDENTIFIER_ISSUER: "INSIGHT_TEST",
      INSIGHT_OFFICIAL_IDENTIFIER_PATTERN: "^SYNTHETIC-[0-9]{6}$",
      INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION: "NFKC_UPPERCASE",
    }),
    identifierConfiguration,
  );
  assert.throws(() => officialIdentifierConfigurationFromEnv({}), /are required/);
});
