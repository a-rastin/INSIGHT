export function makeSyntheticPatientIdentity(sequence = 1) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("Synthetic identity sequence must be an integer from 1 through 999999.");
  }

  const token = String(sequence).padStart(6, "0");
  return Object.freeze({
    patientUuid: `00000000-0000-4000-8000-${token.padStart(12, "0")}`,
    firstName: "Synthetic",
    lastName: `Researcher${token}`,
    officialIdentifier: `SYNTHETIC-${token}`,
    email: `patient-${token}@example.invalid`,
    birthDate: "1990-01-01",
    sex: "FEMALE",
  });
}
