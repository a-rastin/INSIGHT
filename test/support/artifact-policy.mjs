const forbiddenPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /postgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@/i,
  /\b(?:nationalCode|officialIdentifier)\s*[:=]\s*["']?(?!SYNTHETIC-)[A-Za-z0-9-]{6,}/i,
  /\b(?:api\.openai\.com|medscape\.com)\b/i,
];

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function artifactPolicyViolations(text) {
  const violations = forbiddenPatterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  const unsafeEmails = [...text.matchAll(emailPattern)]
    .map(([email]) => email)
    .filter((email) => !email.toLowerCase().endsWith("@example.invalid"));
  return [...violations, ...unsafeEmails.map((email) => `non-synthetic email: ${email}`)];
}
