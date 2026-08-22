import argon2 from "argon2";

export interface PasswordPolicy {
  readonly version: number;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly hashLength: number;
}

export const CURRENT_PASSWORD_POLICY: PasswordPolicy = Object.freeze({
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

export interface PasswordVerification {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

function assertPassword(password: string): void {
  if (password.length < 1) throw new RangeError("Password must contain at least 1 character.");
}

function argon2Options(policy: PasswordPolicy) {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new RangeError("Password policy version must be a positive integer.");
  }
  return {
    type: argon2.argon2id,
    version: 0x13,
    memoryCost: policy.memoryCost,
    timeCost: policy.timeCost,
    parallelism: policy.parallelism,
    hashLength: policy.hashLength,
  } as const;
}

export async function hashPassword(
  password: string,
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<string> {
  assertPassword(password);
  return argon2.hash(password, argon2Options(policy));
}

export async function verifyPasswordHash(
  password: string,
  encodedHash: string,
  storedPolicyVersion: number,
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<PasswordVerification> {
  if (password.length < 1) return { valid: false, needsRehash: false };
  const options = argon2Options(policy);
  try {
    const valid = await argon2.verify(encodedHash, password);
    return {
      valid,
      needsRehash:
        valid &&
        (storedPolicyVersion !== policy.version || argon2.needsRehash(encodedHash, options)),
    };
  } catch {
    return { valid: false, needsRehash: false };
  }
}
