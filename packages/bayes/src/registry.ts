import type { Diagnostic } from "./diagnostics.js";
import { hashXmlBifSemantics } from "./hash.js";
import type { XmlBifFile } from "./model.js";
import { parseXmlBif } from "./parser.js";
import { serializeXmlBif } from "./serializer.js";
import { validateFile } from "./validator.js";

export const BN_REGISTRY_SCHEMA_VERSION = 1;
export const BN_IMPORTER_VERSION = "1.0.0";
export const AKATHISIA_MISMATCHED_CONTENT_SHA256 =
  "7a84bdfe6314c16c10f4fb7503b067acada790f9e7feb369ab5bcf9925196022";

export type BnModelLifecycle =
  | "IMPORTED"
  | "REJECTED"
  | "QUARANTINED"
  | "ACTIVE"
  | "SUPERSEDED"
  | "DISABLED";

export interface BnRepositoryCandidate {
  readonly pathwayIdentity: string;
  readonly artifactPath: string;
  readonly version: number;
}

export interface BnGovernanceMetadata {
  readonly status: string;
  readonly reference: string;
  readonly notes?: string;
}

export interface BnValidationCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface BnValidationReport {
  readonly schemaVersion: 1;
  readonly importerVersion: string;
  readonly softwareCompatible: boolean;
  readonly clinicalValidity: "NOT_ESTABLISHED";
  readonly checks: readonly BnValidationCheck[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface BnModelArtifact {
  readonly path: string;
  readonly mediaType: "application/xml";
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly semanticSha256: string | null;
  readonly topologySha256: string | null;
}

export interface BnModelVersion {
  readonly pathwayIdentity: string;
  readonly version: number;
  readonly artifact: BnModelArtifact;
  readonly validationReport: BnValidationReport;
  readonly evidence: BnGovernanceMetadata;
  readonly calibration: BnGovernanceMetadata;
  readonly clinicalReview: BnGovernanceMetadata;
  readonly lifecycle: BnModelLifecycle;
  readonly quarantineReason: string | null;
}

export interface BnModelImport {
  readonly candidate: BnRepositoryCandidate;
  readonly source: string;
  readonly evidence?: BnGovernanceMetadata;
  readonly calibration?: BnGovernanceMetadata;
  readonly clinicalReview?: BnGovernanceMetadata;
}

export const REPOSITORY_BN_CANDIDATES: readonly BnRepositoryCandidate[] = Object.freeze([
  candidate(
    "LONG_ACTING_ANTIPSYCHOTIC",
    "10 - Long Acting Antipsychotic Medications/gemini-code-1783423101383.xml",
  ),
  candidate(
    "ACUTE_DYSTONIA",
    "11 - Acute Dystonia & anticholinergic therapy/gemini-code-1783438905589.xml",
  ),
  candidate(
    "ANTIPSYCHOTIC_PARKINSONISM",
    "12 - Treatments for Parkinsonism/gemini-code-1783423778176.xml",
  ),
  candidate("AKATHISIA", "13 - Treatments for Akathesia/gemini-code-1783423969512.xml"),
  candidate(
    "TARDIVE_DYSKINESIA",
    "14 - VMAT2 Medications for Tardive Dyskinesia/vmat2_tardive_dyskinesia_bn.xml",
  ),
  candidate("CONTINUING_MEDICATION", "5 - Continuing Medications/gemini-code-1783421787562.xml"),
  candidate(
    "CONTINUING_SAME_MEDICATION",
    "6 - Continuing the Same Medication/gemini-code-1783439886327.xml",
  ),
  candidate(
    "CLOZAPINE_TREATMENT_RESISTANCE",
    "7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml",
  ),
  candidate(
    "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
    "9 - Clozapine in Aggressive Behavior _/gemini-code-1783422744909.xml",
  ),
  candidate("CLOZAPINE_SUICIDE_RISK", "Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml"),
  candidate(
    "INVOLUNTARY_TREATMENT",
    "Involuntary-Treatment-Considerations/BN-Involuntary-Treatment-Considerations.xml",
  ),
  candidate("PHARMACOTHERAPY", "Pharmacotherapy/BN-Pharmacotherapy.xml"),
  candidate("TREATMENT_SETTING", "Treatment-Setting/BN-Treatment-Setting.xml"),
]);

const unreviewed: BnGovernanceMetadata = Object.freeze({
  status: "UNREVIEWED",
  reference: "REPOSITORY-CANDIDATE-NO-CLINICAL-APPROVAL",
});
const uncalibrated: BnGovernanceMetadata = Object.freeze({
  status: "UNCALIBRATED",
  reference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
});

export async function importBnModel(input: BnModelImport): Promise<BnModelVersion> {
  const contentSha256 = await sha256(input.source);
  const checks: BnValidationCheck[] = [];
  const parsed = parseXmlBif(input.source);
  checks.push(
    check(
      "SECURE_PARSE",
      parsed.ok,
      parsed.ok ? "XML parsed within configured limits." : "XML parsing failed.",
    ),
  );

  let diagnostics: Diagnostic[] = parsed.ok ? [...parsed.warnings] : [...parsed.diagnostics];
  let semanticSha256: string | null = null;
  let topologySha256: string | null = null;

  if (parsed.ok) {
    const supported = parsed.file.version === "0.3";
    checks.push(
      check("SUPPORTED_XMLBIF_VERSION", supported, `XMLBIF version is ${parsed.file.version}.`),
    );
    const validation = validateFile(parsed.file);
    diagnostics = [...diagnostics, ...validation];
    const valid = !validation.some(({ severity }) => severity === "error");
    checks.push(
      check(
        "MODEL_VALIDATION",
        valid,
        valid
          ? "Structure and tables pass software validation."
          : "Structure or tables fail software validation.",
      ),
    );

    if (supported && valid) {
      semanticSha256 = await hashXmlBifSemantics(parsed.file);
      topologySha256 = await hashTopology(parsed.file);
      const serialized = serializeXmlBif(parsed.file);
      const reparsed = parseXmlBif(serialized);
      const roundTrip =
        reparsed.ok &&
        serializeXmlBif(reparsed.file) === serialized &&
        (await hashXmlBifSemantics(reparsed.file)) === semanticSha256;
      checks.push(
        check(
          "DETERMINISTIC_ROUND_TRIP",
          roundTrip,
          roundTrip ? "Canonical round trip is stable." : "Canonical round trip failed.",
        ),
      );
    } else {
      checks.push(
        check(
          "DETERMINISTIC_ROUND_TRIP",
          false,
          "Round trip skipped because blocking checks failed.",
        ),
      );
    }
  } else {
    checks.push(
      check("SUPPORTED_XMLBIF_VERSION", false, "Version unavailable because parsing failed."),
      check("MODEL_VALIDATION", false, "Validation unavailable because parsing failed."),
      check("DETERMINISTIC_ROUND_TRIP", false, "Round trip unavailable because parsing failed."),
    );
  }

  const softwareCompatible = checks.every(({ passed }) => passed);
  const mismatchedAkathisia =
    input.candidate.pathwayIdentity === "AKATHISIA" &&
    contentSha256 === AKATHISIA_MISMATCHED_CONTENT_SHA256;
  const lifecycle: BnModelLifecycle = mismatchedAkathisia
    ? "QUARANTINED"
    : softwareCompatible
      ? "ACTIVE"
      : "REJECTED";

  return immutable({
    pathwayIdentity: input.candidate.pathwayIdentity,
    version: input.candidate.version,
    artifact: {
      path: input.candidate.artifactPath,
      mediaType: "application/xml",
      byteLength: new TextEncoder().encode(input.source).byteLength,
      contentSha256,
      semanticSha256,
      topologySha256,
    },
    validationReport: {
      schemaVersion: BN_REGISTRY_SCHEMA_VERSION,
      importerVersion: BN_IMPORTER_VERSION,
      softwareCompatible,
      clinicalValidity: "NOT_ESTABLISHED",
      checks,
      diagnostics,
    },
    evidence: { ...(input.evidence ?? unreviewed) },
    calibration: { ...(input.calibration ?? uncalibrated) },
    clinicalReview: { ...(input.clinicalReview ?? unreviewed) },
    lifecycle,
    quarantineReason: mismatchedAkathisia
      ? "Artifact content describes alcohol, sleep-apnea, opioid, and benzodiazepine interventions rather than an Akathisia pathway."
      : null,
  });
}

function candidate(pathwayIdentity: string, artifactPath: string): BnRepositoryCandidate {
  return Object.freeze({ pathwayIdentity, artifactPath, version: 1 });
}

function check(code: string, passed: boolean, detail: string): BnValidationCheck {
  return { code, passed, detail };
}

async function sha256(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashTopology(file: XmlBifFile): Promise<string> {
  return sha256(
    JSON.stringify(
      file.networks.map((network) => ({
        name: network.name,
        variables: network.variables.map(({ name, type, outcomes }) => ({ name, type, outcomes })),
        definitions: network.definitions.map(({ for: child, given }) => ({ child, given })),
      })),
    ),
  );
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
