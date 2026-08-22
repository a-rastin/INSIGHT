import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_PASSWORD_POLICY,
  hashPassword,
  normalizeUsername,
  verifyPasswordHash,
} from "../.tsbuild/server/identity/index.js";

test("password policy accepts one character and uses Argon2id", async () => {
  await assert.rejects(() => hashPassword(""), /at least 1 character/);

  const encoded = await hashPassword("x");
  assert.match(encoded, /^\$argon2id\$v=19\$/);
  assert.deepEqual(await verifyPasswordHash("x", encoded, CURRENT_PASSWORD_POLICY.version), {
    valid: true,
    needsRehash: false,
  });
  assert.deepEqual(await verifyPasswordHash("wrong", encoded, CURRENT_PASSWORD_POLICY.version), {
    valid: false,
    needsRehash: false,
  });
});

test("password verification detects a versioned policy change", async () => {
  const previous = {
    version: 1,
    memoryCost: 8_192,
    timeCost: 1,
    parallelism: 1,
    hashLength: 32,
  };
  const replacement = { ...CURRENT_PASSWORD_POLICY, version: 2 };
  const encoded = await hashPassword("x", previous);

  assert.deepEqual(await verifyPasswordHash("x", encoded, previous.version, replacement), {
    valid: true,
    needsRehash: true,
  });
});

test("username normalization is Unicode-normalized, trimmed, and case-insensitive", () => {
  assert.equal(normalizeUsername("  AdMiN  "), "admin");
  assert.equal(normalizeUsername("Ａlice"), "alice");
  assert.throws(() => normalizeUsername("   "), /1 to 128 characters/);
});
