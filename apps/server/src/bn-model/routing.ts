import { createHash } from "node:crypto";

import { stableSerialize, type JsonValue, type Role } from "@insight/contracts";
import type { Pool, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export const BN_ROUTING_ARTIFACT_VERSION = "6.0.0";

export interface BnRoutingFacts {
  readonly demographics: { readonly age: number; readonly sex: "MALE" | "FEMALE" };
  readonly presentationStatus: "FIRST_PRESENTATION" | "KNOWN_SCHIZOPHRENIA" | null;
  readonly assessments: readonly {
    readonly type: "DSM5TR" | "PANSS" | "CSSRS_RECENT";
    readonly state: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED" | "IMPUTED";
    readonly result?: string;
  }[];
  readonly comorbidityTermIds: readonly string[];
  readonly medicationHistory: readonly {
    readonly canonicalMedicationId?: string;
    readonly response?: string;
    readonly adequateDose?: boolean;
    readonly adequateDuration?: boolean;
    readonly adequateAdherence?: boolean;
  }[];
  readonly currentRegimen: readonly { readonly canonicalMedicationId: string }[];
  readonly medicationPlanRevision?: {
    readonly sourcePlanRef: string;
    readonly sourcePlanRevision: number;
    readonly targetPlanRevision: number;
    readonly relationship: "REVISES";
  };
  readonly aggressiveBehavior?: {
    readonly riskAfterOtherTreatments:
      | "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS"
      | "NOT_SUBSTANTIAL_OR_CONTROLLED"
      | "INSUFFICIENT_OTHER_TREATMENT_OR_ADHERENCE_ASSESSMENT";
  };
}

export type BnRoutingCondition =
  | { readonly fact: "AGE_BETWEEN"; readonly minimum: number; readonly maximum: number }
  | { readonly fact: "SEX_IN"; readonly values: readonly BnRoutingFacts["demographics"]["sex"][] }
  | {
      readonly fact: "PRESENTATION_STATUS_IN";
      readonly values: readonly Exclude<BnRoutingFacts["presentationStatus"], null>[];
    }
  | {
      readonly fact: "ASSESSMENT_STATE_IN";
      readonly assessmentType: BnRoutingFacts["assessments"][number]["type"];
      readonly values: readonly BnRoutingFacts["assessments"][number]["state"][];
    }
  | {
      readonly fact: "ASSESSMENT_RESULT_IN";
      readonly assessmentType: BnRoutingFacts["assessments"][number]["type"];
      readonly values: readonly string[];
    }
  | { readonly fact: "COMORBIDITY_ANY"; readonly values: readonly string[] }
  | { readonly fact: "PRIOR_MEDICATION_ANY"; readonly values: readonly string[] }
  | { readonly fact: "PRIOR_RESPONSE_IN"; readonly values: readonly string[] }
  | {
      readonly fact: "ADEQUATE_PRIOR_TRIAL_COUNT_AT_LEAST";
      readonly minimum: number;
      readonly responses: readonly string[];
    }
  | {
      readonly fact: "AGGRESSION_RISK_AFTER_OTHER_TREATMENTS_IN";
      readonly values: readonly NonNullable<
        BnRoutingFacts["aggressiveBehavior"]
      >["riskAfterOtherTreatments"][];
    }
  | { readonly fact: "CURRENT_MEDICATION_ANY"; readonly values: readonly string[] }
  | { readonly fact: "CONTINUING_MEDICATION_REVISION" }
  | { readonly fact: "CURRENT_REGIMEN_NONADHERENCE_HISTORY" };

export interface BnRoutingRule {
  readonly ref: string;
  readonly routeGroup: string;
  readonly pathwayIdentity: string;
  readonly expectedContentSha256?: string;
  readonly all: readonly BnRoutingCondition[];
}

export interface BnRoutingArtifact {
  readonly version: string;
  readonly approvalRef: string;
  readonly requiredRouteGroups: readonly string[];
  readonly optionalRouteGroups?: readonly string[];
  readonly rules: readonly BnRoutingRule[];
}

export interface BnPathwayExecutionProfile {
  readonly pathwayIdentity: string;
  readonly artifactPath: string;
  readonly contentSha256: string;
  readonly requestedOutputNodeRefs: readonly string[];
  readonly evidence: {
    readonly clinicalReviewStatus: "NOT_ESTABLISHED";
    readonly clinicalReviewReference: string;
    readonly calibrationStatus: "UNCALIBRATED";
    readonly calibrationReference: string;
    readonly limitations: readonly string[];
  };
}

export interface ActiveBnModel {
  readonly modelId: string;
  readonly pathwayIdentity: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly semanticSha256: string;
  readonly sourceReference: string;
}

export interface BnRoutingDecision {
  readonly routingArtifactVersion: string;
  readonly approvalRef: string;
  readonly matchedRuleRefs: readonly string[];
  readonly selectedModels: readonly ActiveBnModel[];
}

export const INITIAL_BN_ROUTING_ARTIFACT: BnRoutingArtifact = {
  version: BN_ROUTING_ARTIFACT_VERSION,
  approvalRef: "BN-PATHWAY-STRUCTURED-MAPPING-REVIEW-2026-08-25-V6",
  requiredRouteGroups: ["PRIMARY_TREATMENT", "TREATMENT_SETTING"],
  optionalRouteGroups: [
    "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
    "CLOZAPINE_TREATMENT_RESISTANCE",
    "CLOZAPINE_SUICIDE_RISK",
    "CONTINUING_MEDICATION",
    "LONG_ACTING_ANTIPSYCHOTIC",
  ],
  rules: [
    {
      ref: "BN-ROUTE-PHARMACOTHERAPY-001",
      routeGroup: "PRIMARY_TREATMENT",
      pathwayIdentity: "PHARMACOTHERAPY",
      all: [
        {
          fact: "PRESENTATION_STATUS_IN",
          values: ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"],
        },
      ],
    },
    {
      ref: "BN-ROUTE-TREATMENT-SETTING-001",
      routeGroup: "TREATMENT_SETTING",
      pathwayIdentity: "TREATMENT_SETTING",
      expectedContentSha256: "2208cadaf8938ab1bb82b8f985296f3f75241002b8ca0958ce27a7b89010be91",
      all: [
        {
          fact: "PRESENTATION_STATUS_IN",
          values: ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"],
        },
        { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
        {
          fact: "ASSESSMENT_RESULT_IN",
          assessmentType: "DSM5TR",
          values: ["SCHIZOPHRENIA_CONFIRMED"],
        },
      ],
    },
    {
      ref: "BN-ROUTE-CONTINUING-MEDICATION-001",
      routeGroup: "CONTINUING_MEDICATION",
      pathwayIdentity: "CONTINUING_MEDICATION",
      expectedContentSha256: "9527c9c7c0efdfa2caf748fb7ebceaad8715ff79b89180305ba9d0aef3e8b355",
      all: [
        { fact: "PRESENTATION_STATUS_IN", values: ["KNOWN_SCHIZOPHRENIA"] },
        { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
        {
          fact: "ASSESSMENT_RESULT_IN",
          assessmentType: "DSM5TR",
          values: ["SCHIZOPHRENIA_CONFIRMED"],
        },
        { fact: "CONTINUING_MEDICATION_REVISION" },
      ],
    },
    {
      ref: "BN-ROUTE-LONG-ACTING-ANTIPSYCHOTIC-001",
      routeGroup: "LONG_ACTING_ANTIPSYCHOTIC",
      pathwayIdentity: "LONG_ACTING_ANTIPSYCHOTIC",
      expectedContentSha256: "2e9cef62653f687b81cbad7d5c4f6f390a8f3c1824ae5c7bf5671e4b88b3ed2d",
      all: [{ fact: "CURRENT_REGIMEN_NONADHERENCE_HISTORY" }],
    },
    {
      ref: "BN-ROUTE-CLOZAPINE-AGGRESSIVE-BEHAVIOR-001",
      routeGroup: "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
      pathwayIdentity: "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
      expectedContentSha256: "424562a955ef0def89e93f8fede10e87b7bd65b6b9e95182634baecfa1786416",
      all: [
        { fact: "PRESENTATION_STATUS_IN", values: ["KNOWN_SCHIZOPHRENIA"] },
        { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
        {
          fact: "ASSESSMENT_RESULT_IN",
          assessmentType: "DSM5TR",
          values: ["SCHIZOPHRENIA_CONFIRMED"],
        },
        {
          fact: "AGGRESSION_RISK_AFTER_OTHER_TREATMENTS_IN",
          values: ["SUBSTANTIAL_DESPITE_OTHER_TREATMENTS"],
        },
      ],
    },
    {
      ref: "BN-ROUTE-CLOZAPINE-TRS-001",
      routeGroup: "CLOZAPINE_TREATMENT_RESISTANCE",
      pathwayIdentity: "CLOZAPINE_TREATMENT_RESISTANCE",
      expectedContentSha256: "faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb",
      all: [
        { fact: "PRESENTATION_STATUS_IN", values: ["KNOWN_SCHIZOPHRENIA"] },
        { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
        {
          fact: "ASSESSMENT_RESULT_IN",
          assessmentType: "DSM5TR",
          values: ["SCHIZOPHRENIA_CONFIRMED"],
        },
        {
          fact: "ADEQUATE_PRIOR_TRIAL_COUNT_AT_LEAST",
          minimum: 2,
          responses: ["NO_RESPONSE", "PARTIAL_RESPONSE"],
        },
      ],
    },
    {
      ref: "BN-ROUTE-CLOZAPINE-SUICIDE-RISK-001",
      routeGroup: "CLOZAPINE_SUICIDE_RISK",
      pathwayIdentity: "CLOZAPINE_SUICIDE_RISK",
      expectedContentSha256: "90f633bee7da1625ca4d44d35ace5acace5ca51ee7d597541ee7a5d0089acf3a",
      all: [
        { fact: "PRESENTATION_STATUS_IN", values: ["KNOWN_SCHIZOPHRENIA"] },
        { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
        {
          fact: "ASSESSMENT_RESULT_IN",
          assessmentType: "DSM5TR",
          values: ["SCHIZOPHRENIA_CONFIRMED"],
        },
        {
          fact: "ASSESSMENT_STATE_IN",
          assessmentType: "CSSRS_RECENT",
          values: ["COMPLETED", "BYPASSED", "IMPUTED"],
        },
      ],
    },
  ],
};

export const BN_PATHWAY_EXECUTION_PROFILES: Readonly<Record<string, BnPathwayExecutionProfile>> =
  Object.freeze({
    TREATMENT_SETTING: Object.freeze({
      pathwayIdentity: "TREATMENT_SETTING",
      artifactPath: "Treatment-Setting/BN-Treatment-Setting.xml",
      contentSha256: "2208cadaf8938ab1bb82b8f985296f3f75241002b8ca0958ce27a7b89010be91",
      requestedOutputNodeRefs: Object.freeze([
        "inpatient_care_priority",
        "inpatient_service_priority",
        "less_restrictive_care_priority",
        "management_recommendation",
      ]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "Base CPTs are placeholder distributions and are not clinically calibrated.",
          "Patient-specific LLM-generated CPTs have mathematical validation only.",
          "Output is research decision support and requires psychiatrist review.",
        ]),
      }),
    }),
    CONTINUING_MEDICATION: Object.freeze({
      pathwayIdentity: "CONTINUING_MEDICATION",
      artifactPath: "5 - Continuing Medications/gemini-code-1783421787562.xml",
      contentSha256: "9527c9c7c0efdfa2caf748fb7ebceaad8715ff79b89180305ba9d0aef3e8b355",
      requestedOutputNodeRefs: Object.freeze([
        "maintenance_antipsychotic_eligibility",
        "adherence_strategy_priority",
        "medication_adjustment_priority",
        "management_recommendation",
      ]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "Medication continuation routing requires an explicit improved response and same normalized prior/current medication; it does not establish clinical appropriateness.",
          "CPT probabilities are qualitative placeholders and are not clinically calibrated.",
          "Plan revision, adverse-effect, interaction, monitoring, patient-preference, and psychiatrist review remain required.",
        ]),
      }),
    }),
    LONG_ACTING_ANTIPSYCHOTIC: Object.freeze({
      pathwayIdentity: "LONG_ACTING_ANTIPSYCHOTIC",
      artifactPath: "10 - Long Acting Antipsychotic Medications/gemini-code-1783423101383.xml",
      contentSha256: "2e9cef62653f687b81cbad7d5c4f6f390a8f3c1824ae5c7bf5671e4b88b3ed2d",
      requestedOutputNodeRefs: Object.freeze([
        "LAIIndicationStrength",
        "LAISafetySuitability",
        "ImplementationBarriers",
        "NetClinicalFavorability",
        "LAIRecommendation",
      ]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "Routing requires an explicit nonadherence record for a medication in the current regimen; it does not establish LAI eligibility or preference.",
          "CPT probabilities are qualitative placeholders and are not clinically calibrated.",
          "Formulation, tolerability, contraindication, access, patient preference, and psychiatrist review remain required.",
        ]),
      }),
    }),
    CLOZAPINE_AGGRESSIVE_BEHAVIOR: Object.freeze({
      pathwayIdentity: "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
      artifactPath: "9 - Clozapine in Aggressive Behavior _/gemini-code-1783422744909.xml",
      contentSha256: "424562a955ef0def89e93f8fede10e87b7bd65b6b9e95182634baecfa1786416",
      requestedOutputNodeRefs: Object.freeze([
        "ClozapineIndicationPriority",
        "ClozapineEligibility",
        "ManagementRecommendation",
      ]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "Structured persistent aggression status is a routing prerequisite, not a validated violence-risk assessment.",
          "CPT probabilities are qualitative placeholders and are not clinically calibrated.",
          "Current prescribing information, monitoring rules, safety review, and psychiatrist judgment remain required.",
        ]),
      }),
    }),
    CLOZAPINE_TREATMENT_RESISTANCE: Object.freeze({
      pathwayIdentity: "CLOZAPINE_TREATMENT_RESISTANCE",
      artifactPath:
        "7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml",
      contentSha256: "faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb",
      requestedOutputNodeRefs: Object.freeze([
        "TreatmentResistanceStatus",
        "ClozapineEligibility",
        "ClozapinePriority",
        "ClozapineImplementationMode",
        "ECTPriority",
        "TMSPriority",
        "ManagementRecommendation",
      ]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "Two adequate adherent trials are a routing prerequisite, not a diagnosis of treatment resistance.",
          "Base CPTs are qualitative placeholders and are not clinically calibrated.",
          "Current prescribing information, monitoring rules, safety review, and psychiatrist judgment remain required.",
        ]),
      }),
    }),
    CLOZAPINE_SUICIDE_RISK: Object.freeze({
      pathwayIdentity: "CLOZAPINE_SUICIDE_RISK",
      artifactPath: "Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml",
      contentSha256: "90f633bee7da1625ca4d44d35ace5acace5ca51ee7d597541ee7a5d0089acf3a",
      requestedOutputNodeRefs: Object.freeze(["Clozapine_Eligibility", "Clinical_Action_Pattern"]),
      evidence: Object.freeze({
        clinicalReviewStatus: "NOT_ESTABLISHED",
        clinicalReviewReference: "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        calibrationStatus: "UNCALIBRATED",
        calibrationReference: "REPOSITORY-CANDIDATE-NO-CALIBRATION-REPORT",
        limitations: Object.freeze([
          "C-SSRS completion, bypass, or imputation selects this research pathway without creating a suicide-risk action gate.",
          "Root priors are qualitative placeholders and are not clinically calibrated.",
          "C-SSRS findings remain warning-only; current prescribing information, monitoring rules, safety review, and psychiatrist judgment remain required.",
        ]),
      }),
    }),
  });

export class BnRoutingError extends Error {
  constructor(
    readonly code:
      | "INVALID_ROUTING_ARTIFACT"
      | "INVALID_ROUTING_FACTS"
      | "AMBIGUOUS_ROUTE"
      | "MISSING_REQUIRED_ROUTE"
      | "MISSING_ACTIVE_MODEL"
      | "PINNED_MODEL_MISMATCH",
  ) {
    super(code);
    this.name = "BnRoutingError";
  }
}

export class BnRoutingAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to route Bayesian models.");
    this.name = "BnRoutingAuthorizationError";
  }
}

export function evaluateBnRouting(
  facts: BnRoutingFacts,
  artifact: BnRoutingArtifact,
  activeModels: readonly ActiveBnModel[],
): BnRoutingDecision {
  validateFacts(facts);
  validateArtifact(artifact);
  const matched = artifact.rules.filter((rule) =>
    rule.all.every((condition) => matches(facts, condition)),
  );
  const selectedRules = artifact.requiredRouteGroups.map((routeGroup) => {
    const groupMatches = matched.filter((rule) => rule.routeGroup === routeGroup);
    if (groupMatches.length === 0) throw new BnRoutingError("MISSING_REQUIRED_ROUTE");
    if (groupMatches.length !== 1) throw new BnRoutingError("AMBIGUOUS_ROUTE");
    return groupMatches[0]!;
  });
  for (const routeGroup of artifact.optionalRouteGroups ?? []) {
    const groupMatches = matched.filter((rule) => rule.routeGroup === routeGroup);
    if (groupMatches.length > 1) throw new BnRoutingError("AMBIGUOUS_ROUTE");
    if (groupMatches[0]) selectedRules.push(groupMatches[0]);
  }
  const selectedModels = selectedRules.map((rule) => {
    const models = activeModels.filter(
      ({ pathwayIdentity, contentSha256 }) =>
        pathwayIdentity === rule.pathwayIdentity &&
        (!rule.expectedContentSha256 || contentSha256 === rule.expectedContentSha256),
    );
    if (models.length !== 1) throw new BnRoutingError("MISSING_ACTIVE_MODEL");
    return models[0]!;
  });
  return {
    routingArtifactVersion: artifact.version,
    approvalRef: artifact.approvalRef,
    matchedRuleRefs: matched.map(({ ref }) => ref).sort(),
    selectedModels: [...selectedModels].sort((left, right) =>
      left.pathwayIdentity.localeCompare(right.pathwayIdentity),
    ),
  };
}

interface ActiveModelRow extends QueryResultRow {
  model_id: string;
  pathway_identity: string;
  version: number;
  content_sha256: string;
  semantic_sha256: string;
  source_reference: string;
}

export async function routeAndRecordBnModels(
  pool: Pool,
  actor: { readonly id: string; readonly role: Role },
  input: {
    readonly researchCaseId: string;
    readonly researchCaseRevision: number;
    readonly facts: BnRoutingFacts;
    readonly artifact?: BnRoutingArtifact;
    readonly now?: Date;
  },
): Promise<BnRoutingDecision & { readonly evaluationId: string }> {
  if (actor.role !== "PSYCHIATRIST") throw new BnRoutingAuthorizationError();
  const artifact = input.artifact ?? INITIAL_BN_ROUTING_ARTIFACT;
  return withTransaction(pool, async (client) => {
    const active = await client.query<ActiveModelRow>(
      `SELECT model.id AS model_id, model.pathway_identity, model.version,
              artifact.content_sha256, artifact.semantic_sha256,
              initial.event_reference AS source_reference
       FROM insight.bn_active_models active
       JOIN insight.bn_model_versions model ON model.id = active.model_version_id
       JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
       JOIN LATERAL (
         SELECT event_reference FROM insight.bn_model_lifecycle_events event
         WHERE event.model_version_id = model.id ORDER BY sequence LIMIT 1
       ) initial ON true
       WHERE (model.validation_report->>'softwareCompatible')::boolean
         AND artifact.semantic_sha256 IS NOT NULL`,
    );
    const decision = evaluateBnRouting(
      input.facts,
      artifact,
      active.rows.map((row) => ({
        modelId: row.model_id,
        pathwayIdentity: row.pathway_identity,
        version: Number(row.version),
        contentSha256: row.content_sha256,
        semanticSha256: row.semantic_sha256,
        sourceReference: row.source_reference,
      })),
    );
    const inputSha256 = createHash("sha256")
      .update(stableSerialize(input.facts as unknown as JsonValue))
      .digest("hex");
    for (const model of decision.selectedModels) {
      const pin = await client.query(
        `INSERT INTO insight.bn_research_case_model_pins (
           research_case_id, pathway_identity, model_version_id, model_version,
           content_sha256, semantic_sha256, pinned_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (research_case_id, pathway_identity) DO NOTHING`,
        [
          input.researchCaseId,
          model.pathwayIdentity,
          model.modelId,
          model.version,
          model.contentSha256,
          model.semanticSha256,
          input.now ?? new Date(),
        ],
      );
      if (pin.rowCount === 0) {
        const existing = await client.query<{ model_version_id: string }>(
          `SELECT model_version_id FROM insight.bn_research_case_model_pins
           WHERE research_case_id = $1 AND pathway_identity = $2`,
          [input.researchCaseId, model.pathwayIdentity],
        );
        if (existing.rows[0]?.model_version_id !== model.modelId) {
          throw new BnRoutingError("PINNED_MODEL_MISMATCH");
        }
      }
    }
    const recorded = await client.query<{ id: string }>(
      `INSERT INTO insight.bn_routing_evaluations (
         research_case_id, research_case_revision, routing_artifact_version,
         routing_approval_ref, input_sha256, matched_rule_refs, selected_models,
         evaluated_by_user_id, evaluated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        input.researchCaseId,
        input.researchCaseRevision,
        decision.routingArtifactVersion,
        decision.approvalRef,
        inputSha256,
        JSON.stringify(decision.matchedRuleRefs),
        JSON.stringify(decision.selectedModels),
        actor.id,
        input.now ?? new Date(),
      ],
    );
    return { ...decision, evaluationId: recorded.rows[0]!.id };
  });
}

function validateArtifact(artifact: BnRoutingArtifact): void {
  const refs = new Set(artifact.rules.map(({ ref }) => ref));
  const routeGroups = [...artifact.requiredRouteGroups, ...(artifact.optionalRouteGroups ?? [])];
  const groups = new Set(routeGroups);
  if (
    !artifact.version ||
    !artifact.approvalRef ||
    refs.size !== artifact.rules.length ||
    groups.size !== routeGroups.length ||
    artifact.requiredRouteGroups.length === 0 ||
    artifact.rules.some(
      (rule) =>
        !groups.has(rule.routeGroup) ||
        rule.all.length === 0 ||
        rule.all.some((condition) => !validCondition(condition)) ||
        (rule.expectedContentSha256 !== undefined &&
          !/^[0-9a-f]{64}$/.test(rule.expectedContentSha256)),
    )
  ) {
    throw new BnRoutingError("INVALID_ROUTING_ARTIFACT");
  }
}

function validCondition(condition: BnRoutingCondition): boolean {
  if (!condition || typeof condition !== "object" || typeof condition.fact !== "string") {
    return false;
  }
  const tokens = (values: readonly unknown[]) =>
    values.length > 0 &&
    values.every(
      (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(value),
    );
  switch (condition.fact) {
    case "AGE_BETWEEN":
      return (
        Number.isSafeInteger(condition.minimum) &&
        Number.isSafeInteger(condition.maximum) &&
        condition.minimum >= 0 &&
        condition.maximum <= 130 &&
        condition.minimum <= condition.maximum
      );
    case "SEX_IN":
      return (
        condition.values.length > 0 &&
        condition.values.every((value) => ["MALE", "FEMALE"].includes(value))
      );
    case "PRESENTATION_STATUS_IN":
      return (
        condition.values.length > 0 &&
        condition.values.every((value) =>
          ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"].includes(value),
        )
      );
    case "ASSESSMENT_STATE_IN":
      return (
        ["DSM5TR", "PANSS", "CSSRS_RECENT"].includes(condition.assessmentType) &&
        condition.values.length > 0 &&
        condition.values.every((value) =>
          ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "BYPASSED", "IMPUTED"].includes(value),
        ) &&
        (condition.assessmentType === "CSSRS_RECENT" || !condition.values.includes("IMPUTED"))
      );
    case "ASSESSMENT_RESULT_IN":
      return (
        ["DSM5TR", "PANSS", "CSSRS_RECENT"].includes(condition.assessmentType) &&
        tokens(condition.values)
      );
    case "COMORBIDITY_ANY":
    case "PRIOR_MEDICATION_ANY":
    case "PRIOR_RESPONSE_IN":
    case "CURRENT_MEDICATION_ANY":
      return tokens(condition.values);
    case "ADEQUATE_PRIOR_TRIAL_COUNT_AT_LEAST":
      return (
        Number.isSafeInteger(condition.minimum) &&
        condition.minimum > 0 &&
        tokens(condition.responses)
      );
    case "AGGRESSION_RISK_AFTER_OTHER_TREATMENTS_IN":
      return (
        condition.values.length > 0 &&
        condition.values.every((value) =>
          [
            "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS",
            "NOT_SUBSTANTIAL_OR_CONTROLLED",
            "INSUFFICIENT_OTHER_TREATMENT_OR_ADHERENCE_ASSESSMENT",
          ].includes(value),
        )
      );
    case "CONTINUING_MEDICATION_REVISION":
    case "CURRENT_REGIMEN_NONADHERENCE_HISTORY":
      return Object.keys(condition).length === 1;
    default:
      return false;
  }
}

function validateFacts(facts: BnRoutingFacts): void {
  const assessmentTypes = ["DSM5TR", "PANSS", "CSSRS_RECENT"];
  const assessmentStates = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "BYPASSED", "IMPUTED"];
  const token = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(value);
  if (
    !facts ||
    !Number.isInteger(facts.demographics?.age) ||
    facts.demographics.age < 0 ||
    facts.demographics.age > 130 ||
    !["MALE", "FEMALE"].includes(facts.demographics.sex) ||
    !["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA", null].includes(facts.presentationStatus) ||
    !Array.isArray(facts.assessments) ||
    facts.assessments.length !== assessmentTypes.length ||
    new Set(facts.assessments.map(({ type }) => type)).size !== assessmentTypes.length ||
    facts.assessments.some(
      ({ type, state, result }) =>
        !assessmentTypes.includes(type) ||
        !assessmentStates.includes(state) ||
        (state === "IMPUTED" && type !== "CSSRS_RECENT") ||
        (result !== undefined && !token(result)),
    ) ||
    !Array.isArray(facts.comorbidityTermIds) ||
    facts.comorbidityTermIds.some((value) => !token(value)) ||
    !Array.isArray(facts.medicationHistory) ||
    facts.medicationHistory.some(
      (entry) =>
        Object.keys(entry).some(
          (key) =>
            ![
              "canonicalMedicationId",
              "response",
              "adequateDose",
              "adequateDuration",
              "adequateAdherence",
            ].includes(key),
        ) ||
        (entry.canonicalMedicationId !== undefined && !token(entry.canonicalMedicationId)) ||
        (entry.response !== undefined && !token(entry.response)) ||
        [entry.adequateDose, entry.adequateDuration, entry.adequateAdherence].some(
          (value) => value !== undefined && typeof value !== "boolean",
        ),
    ) ||
    !Array.isArray(facts.currentRegimen) ||
    facts.currentRegimen.some(
      (entry) =>
        Object.keys(entry).some((key) => key !== "canonicalMedicationId") ||
        !token(entry.canonicalMedicationId),
    ) ||
    (facts.medicationPlanRevision !== undefined &&
      (facts.medicationPlanRevision === null ||
        typeof facts.medicationPlanRevision !== "object" ||
        Array.isArray(facts.medicationPlanRevision) ||
        Object.keys(facts.medicationPlanRevision).some(
          (key) =>
            !["sourcePlanRef", "sourcePlanRevision", "targetPlanRevision", "relationship"].includes(
              key,
            ),
        ) ||
        !token(facts.medicationPlanRevision.sourcePlanRef) ||
        !Number.isSafeInteger(facts.medicationPlanRevision.sourcePlanRevision) ||
        facts.medicationPlanRevision.sourcePlanRevision < 1 ||
        !Number.isSafeInteger(facts.medicationPlanRevision.targetPlanRevision) ||
        facts.medicationPlanRevision.targetPlanRevision <=
          facts.medicationPlanRevision.sourcePlanRevision ||
        facts.medicationPlanRevision.relationship !== "REVISES")) ||
    (facts.aggressiveBehavior !== undefined &&
      (facts.aggressiveBehavior === null ||
        typeof facts.aggressiveBehavior !== "object" ||
        Array.isArray(facts.aggressiveBehavior) ||
        Object.keys(facts.aggressiveBehavior).some((key) => key !== "riskAfterOtherTreatments") ||
        ![
          "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS",
          "NOT_SUBSTANTIAL_OR_CONTROLLED",
          "INSUFFICIENT_OTHER_TREATMENT_OR_ADHERENCE_ASSESSMENT",
        ].includes(facts.aggressiveBehavior.riskAfterOtherTreatments)))
  ) {
    throw new BnRoutingError("INVALID_ROUTING_FACTS");
  }
}

function matches(facts: BnRoutingFacts, condition: BnRoutingCondition): boolean {
  switch (condition.fact) {
    case "AGE_BETWEEN":
      return (
        facts.demographics.age >= condition.minimum && facts.demographics.age <= condition.maximum
      );
    case "SEX_IN":
      return condition.values.includes(facts.demographics.sex);
    case "PRESENTATION_STATUS_IN":
      return (
        facts.presentationStatus !== null && condition.values.includes(facts.presentationStatus)
      );
    case "ASSESSMENT_STATE_IN": {
      const assessment = facts.assessments.find(({ type }) => type === condition.assessmentType);
      return assessment !== undefined && condition.values.includes(assessment.state);
    }
    case "ASSESSMENT_RESULT_IN": {
      const assessment = facts.assessments.find(({ type }) => type === condition.assessmentType);
      return assessment?.result !== undefined && condition.values.includes(assessment.result);
    }
    case "COMORBIDITY_ANY":
      return facts.comorbidityTermIds.some((value) => condition.values.includes(value));
    case "PRIOR_MEDICATION_ANY":
      return facts.medicationHistory.some(
        ({ canonicalMedicationId }) =>
          canonicalMedicationId !== undefined && condition.values.includes(canonicalMedicationId),
      );
    case "PRIOR_RESPONSE_IN":
      return facts.medicationHistory.some(
        ({ response }) => response !== undefined && condition.values.includes(response),
      );
    case "ADEQUATE_PRIOR_TRIAL_COUNT_AT_LEAST":
      return (
        Number.isSafeInteger(condition.minimum) &&
        condition.minimum > 0 &&
        new Set(
          facts.medicationHistory
            .filter(
              ({
                canonicalMedicationId,
                response,
                adequateDose,
                adequateDuration,
                adequateAdherence,
              }) =>
                canonicalMedicationId !== undefined &&
                response !== undefined &&
                condition.responses.includes(response) &&
                adequateDose === true &&
                adequateDuration === true &&
                adequateAdherence === true,
            )
            .map(({ canonicalMedicationId }) => canonicalMedicationId),
        ).size >= condition.minimum
      );
    case "AGGRESSION_RISK_AFTER_OTHER_TREATMENTS_IN":
      return (
        facts.aggressiveBehavior !== undefined &&
        condition.values.includes(facts.aggressiveBehavior.riskAfterOtherTreatments)
      );
    case "CURRENT_MEDICATION_ANY":
      return facts.currentRegimen.some(({ canonicalMedicationId }) =>
        condition.values.includes(canonicalMedicationId),
      );
    case "CONTINUING_MEDICATION_REVISION": {
      if (!facts.medicationPlanRevision) return false;
      const improved = new Set(
        facts.medicationHistory
          .filter(({ response }) => response === "IMPROVED")
          .flatMap(({ canonicalMedicationId }) =>
            canonicalMedicationId === undefined ? [] : [canonicalMedicationId],
          ),
      );
      return facts.currentRegimen.some(({ canonicalMedicationId }) =>
        improved.has(canonicalMedicationId),
      );
    }
    case "CURRENT_REGIMEN_NONADHERENCE_HISTORY": {
      const nonadherent = new Set(
        facts.medicationHistory
          .filter(({ adequateAdherence }) => adequateAdherence === false)
          .flatMap(({ canonicalMedicationId }) =>
            canonicalMedicationId === undefined ? [] : [canonicalMedicationId],
          ),
      );
      return facts.currentRegimen.some(({ canonicalMedicationId }) =>
        nonadherent.has(canonicalMedicationId),
      );
    }
  }
}
